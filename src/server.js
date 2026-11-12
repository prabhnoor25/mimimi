import { config } from 'dotenv';
config();

import express from 'express';
import { Database } from './db.js';
import { Search } from './search.js';
import { Agent } from './agent.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { extensions: ['html'] }));

// ---- wiring --------------------------------------------------------------
const db = new Database(process.env.DB_PATH || './data/chat.db');
const search = new Search({ apiKey: process.env.SERPER_API_KEY });
const useOllama = Boolean(process.env.OLLAMA_URL);
const agent = new Agent({
  db,
  search,
  model: process.env.MODEL || (useOllama ? 'qwen2.5:3b' : 'gpt-4o-mini'),
  apiKey: process.env.OPENAI_API_KEY || (useOllama ? 'x' : undefined),
  baseUrl: useOllama ? `${process.env.OLLAMA_URL}/v1` : undefined,
  ollama: useOllama,
});

// ---- API -----------------------------------------------------------------
app.get('/api/conversations', (_req, res) => {
  res.json(db.listConversations());
});

app.post('/api/conversations', (_req, res) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.ensureConversation(id);
  res.json({ id, title: 'New chat', created_at: now, updated_at: now });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  db.ensureConversation(id);
  res.json(db.getMessages(id, 100));
});

/**
 * Streaming chat endpoint (text/event-stream).
 *
 * Client posts { conversationId?, message }. We persist the user message,
 * run the agent loop, and stream events:
 *   text_chunk  { delta }        assistant text as it is generated
 *   tool_result { call, result } a tool call and its result
 *   done        { messageId }    turn complete
 *   error       { message }      something went wrong
 */
app.post('/api/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { conversationId, message } = req.body || {};
    if (!message || typeof message !== 'string') {
      throw new Error('message is required');
    }

    const conv = db.ensureConversation(conversationId || crypto.randomUUID());
    const existed = db.messageCount(conv.id) > 0;

    db.upsertMessage({
      id: crypto.randomUUID(),
      conversationId: conv.id,
      role: 'user',
      content: message,
      createdAt: Date.now(),
    });
    if (!existed) {
      db.maybeSetTitle(conv.id, message);
    }

    send('conversation', { id: conv.id, title: conv.title });

    for await (const event of agent.run({
      conversationId: conv.id,
      userMessage: message,
    })) {
      send(event.type, event.payload);
    }

    send('done', {});
  } catch (err) {
    send('error', { message: err.message || 'Unexpected error' });
  } finally {
    res.end();
  }
});

app.get('/', (_req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`mimimi chat agent listening on http://localhost:${port}`);
  if (!useOllama && !process.env.OPENAI_API_KEY) {
    console.warn('WARNING: neither OLLAMA_URL nor OPENAI_API_KEY set — agent will not work.');
  }
  if (!process.env.SERPER_API_KEY) {
    console.warn('WARNING: SERPER_API_KEY not set — web search disabled.');
  }
});
