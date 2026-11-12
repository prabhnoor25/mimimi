import OpenAI from 'openai';

/**
 * ReAct chat agent with web search and persistent memory.
 *
 * Turn flow (max 6 reasoning steps):
 *   1. Load recent conversation history + relevant excerpts from past
 *      conversations (full-text search on the user's query).
 *   2. Ask the model. It may answer directly, or call web_search / fetch_url.
 *   3. On tool calls: execute them (parallel when there are several), append
 *      results as tool messages, go back to step 2.
 *   4. When the model answers without tools: stream the text to the client and
 *      persist the assistant message.
 *
 * Every message the user sends is stored with a timestamp, so relative-date
 * questions ("last Tuesday", "3 November") can be answered from memory, and
 * web search is used whenever a question smells time-sensitive.
 */
const MAX_STEPS = 6;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information: prices, news, launches, ' +
        'anything that may have changed. Use this whenever the question is ' +
        'time-sensitive or you are not sure of the facts.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch and read the full text of a specific web page. Use it after ' +
        'web_search when a search snippet is not enough to answer.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch and read.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

export class Agent {
  constructor({ db, search, model, apiKey, baseUrl, ollama }) {
    this.db = db;
    this.search = search;
    this.model = model || 'gpt-4o-mini';
    this.ollama = Boolean(ollama);
    // Ollama doesn't require a real API key, but the OpenAI SDK demands a
    // non-empty string. Use a placeholder when talking to Ollama.
    this.configured = Boolean(apiKey);
    this.openai = new OpenAI({
      apiKey: apiKey || 'ollama',
      baseURL: baseUrl || undefined,
    });
  }

  systemPrompt() {
    const today = new Date().toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `You are a helpful, concise chat assistant. Today is ${today}.

You have two tools: web_search(query) and fetch_url(url).

- If a question is about recent events, prices, launches, or anything that could
  have changed, search the web first. Do not guess at time-sensitive facts.
- Above each conversation you are given excerpts from earlier conversations,
  each tagged with a date. Use them to answer "what did I ask..." style
  questions. Compute relative dates (Monday, last Tuesday, 3 November) from
  today's date (${today}).
- Be conversational and brief. When you use the web, mention the source.
- If the search API is unavailable, say so and answer from your own knowledge,
  flagging it as potentially outdated.
- If you genuinely don't know, say so.`;
  }

  async *run({ conversationId, userMessage }) {
    if (!this.configured || this.search.disabled) {
      yield {
        type: 'error',
        payload: {
          message:
            'Agent is not configured: set OPENAI_API_KEY and SERPER_API_KEY in .env',
        },
      };
      return;
    }

    const userId = crypto.randomUUID();
    await this.db.upsertMessage({
      id: userId,
      conversationId,
      role: 'user',
      content: userMessage,
      createdAt: Date.now(),
    });

    const history = this.db.getMessages(conversationId, 40);
    const memory = this.db.searchMessages(userMessage, 6);

    const messages = [{ role: 'system', content: this.systemPrompt() }];
    if (memory.length) {
      messages.push({
        role: 'system',
        content:
          'Relevant excerpts from earlier conversations (with dates):\n' +
          memory
            .map(
              (m) =>
                `- [${new Date(m.created_at).toLocaleDateString('en-GB', {
                  month: 'short',
                  day: 'numeric',
                })}] ${m.role}: ${m.content}`
            )
            .join('\n'),
      });
    }
    messages.push(
      ...history.map((m) => ({ role: m.role, content: m.content }))
    );
    messages.push({ role: 'user', content: userMessage });

    let finalContent = '';
    const assistantToolCalls = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = await this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        temperature: 0.3,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      });

      let stepText = '';
      const callsByIndex = {};

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          stepText += delta.content;
          yield { type: 'text_chunk', payload: { delta: delta.content } };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!callsByIndex[tc.index]) {
              callsByIndex[tc.index] = {
                id: tc.id,
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            const call = callsByIndex[tc.index];
            if (tc.function?.name) call.function.name = tc.function.name;
            if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
          }
        }
      }

      const calls = Object.values(callsByIndex);
      if (calls.length === 0) {
        // Final answer.
        finalContent = stepText;
        messages.push({ role: 'assistant', content: stepText });
        break;
      }

      // Tool use: record the assistant's tool-calling message, execute all
      // calls in parallel, feed results back, and continue the loop.
      messages.push({
        role: 'assistant',
        content: stepText || null,
        tool_calls: calls,
      });
      assistantToolCalls.push(...calls);

      const results = await Promise.all(calls.map((call) => this.executeTool(call)));
      for (let i = 0; i < calls.length; i++) {
        const result = results[i];
        const payload = result.ok ? result.value : { error: result.error };
        messages.push({
          role: 'tool',
          tool_call_id: calls[i].id,
          content: JSON.stringify(payload),
        });
        yield {
          type: 'tool_result',
          payload: { call: calls[i], result: payload },
        };
      }
    }

    if (!finalContent) {
      // Loop ran out of steps without a final answer.
      finalContent = '(I ran out of steps trying to answer that — could you rephrase?)';
    }

    const assistantId = crypto.randomUUID();
    this.db.upsertMessage({
      id: assistantId,
      conversationId,
      role: 'assistant',
      content: finalContent,
      createdAt: Date.now(),
      toolCalls: assistantToolCalls.length ? assistantToolCalls : undefined,
    });
    yield { type: 'done', payload: { messageId: assistantId, content: finalContent } };
  }

  async executeTool(call) {
    const name = call.function.name;
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch (err) {
      return { ok: false, error: 'Invalid tool arguments' };
    }

    try {
      if (name === 'web_search') {
        return { ok: true, value: await this.search.search(args.query) };
      }
      if (name === 'fetch_url') {
        return { ok: true, value: await this.search.fetch(args.url) };
      }
      return { ok: false, error: `Unknown tool: ${name}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

