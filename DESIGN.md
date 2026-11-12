# mimimi chat agent — design

## The problem

The examples in the brief are the hard part:

1. "On Monday we shortlisted 5 CRM tools… Has any of them changed pricing or shipped something big since?" — **recency + memory**: answer requires web search *and* remembering which tools were discussed.
2. "What did I ask you on 3 November? Is your answer still correct today?" — **persistent dated memory + verification**: recall a past turn, then re-search to check whether it still holds.
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" — **fuzzy date recall**: find an old topic from a relative date, then check current prices.

A stateless "ask the model + one search" bot fails all three. This agent is built around three pillars: **memory**, **web tools**, and **streaming UX**.

## Architecture

```
┌─────────────┐     SSE stream      ┌────────────────────┐
│ browser UI  │◄───────────────────►│ Express server     │
│ (vanilla JS)│                     │ src/server.js      │
└─────────────┘                     └────────┬───────────┘
                                             │
                  ┌──────────────────────────┴──────────────────────────┐
                  │  Agent (ReAct loop)              src/agent.js       │
                  │  - system prompt: today's date + tool instructions  │
                  │  - up to 6 reasoning steps                          │
                  │  - streams text chunks as they arrive               │
                  └──────────┬───────────────────────────────┬────────┘
                             │                               │
              ┌──────────────┴───────────────┐      ┌────────▼─────────┐
              │  web_search (Serper)         │      │ fetch_url        │
              │  src/search.js  (cached 1h)  │      │ src/search.js    │
              └──────────────┬───────────────┘      └─────────┬────────┘
                             │                                │
              ┌──────────────┴───────────────┐      ┌──────────▼─────────┐
              │  SQLite + FTS5               │      │  openai SDK        │
              │  src/db.js                   │      │ (any OpenAI-compat)│
              │  - conversations/messages    │      └────────────────────┘
              │  - dated history + keyword   │
              │    search over past turns    │
              └──────────────────────────────┘
```

### 1. Memory — SQLite + FTS5 (`src/db.js`)

Every message is stored with `conversation_id`, `role`, `content`, and `created_at` (epoch ms). Two retrieval strategies feed the model on every turn:

- **Recent history**: the last 40 messages of the current conversation (oldest first) — standard context window.
- **Relevant past excerpts**: a full-text search (FTS5, with LIKE fallback) of the user's current query across *all* stored messages, returning the top 6 matches tagged with their date. This is what makes "what did I ask on 3 November?" and "last Tuesday I asked about Postgres hosting" answerable.

If FTS5 isn't compiled into the local SQLite, the code degrades gracefully to `LIKE` search (detected at startup).

### 2. Agent loop — ReAct (`src/agent.js`)

A minimal hand-rolled ReAct loop rather than a heavy framework, because the whole point of this exercise is control over the reasoning flow:

1. Build the message list: system prompt (with today's date) → relevant past excerpts → recent history → current user message.
2. Stream a model completion with `web_search` and `fetch_url` tools declared (`tool_choice: auto`).
3. If the model emits text only → that's the answer; persist and stream it to the client.
4. If it emits tool calls → execute **all calls in parallel**, append each result as a `tool` message, and loop (max 6 steps).

Tools:
- `web_search(query)` — Serper.dev Google search; returns answer box + top 5 organic results (title, snippet, link, date).
- `fetch_url(url)` — server-side GET, HTML stripped to text, capped at 8 kB. Used when a snippet isn't enough (e.g. "has pricing changed" questions where the price is on the page, not in the snippet).

The model decides when to search; the system prompt pushes it to search for anything time-sensitive and to verify its own past answers when asked "is this still correct?".

### 3. Search (`src/search.js`)

- Serper.dev (`https://google.serper.dev/search`), one API key.
- In-memory cache with 1-hour TTL keyed by normalized query/URL — repeated questions are instant and cheap.
- In-flight deduplication: two turns searching the same query share one promise.

### 4. Speed / UX

- **SSE streaming** (`POST /api/chat` → `text/event-stream`): text chunks arrive as the model generates them; the UI renders incrementally. No waiting for the whole search loop to finish before the user sees the first word.
- **Parallel tool execution**: multiple tool calls in one step fire concurrently.
- **Single `npm run dev`**: `node --watch src/server.js` — no build step, TypeScript-free so there's nothing to compile. (`npm start` for production.)
- Plain vanilla-JS frontend, one small markdown renderer, no framework.

## Data model (SQLite)

```
conversations: id, title, created_at, updated_at
messages:      id, conversation_id, role, content, created_at, tool_calls, tool_call_id
messages_fts:  FTS5 virtual table over messages.content (kept in sync by triggers)
```

## Configuration (`.env`)

Required:
- `OPENAI_API_KEY` — chat + tool use (any OpenAI-compatible endpoint via `OPENAI_BASE_URL`)
- `SERPER_API_KEY` — web search

Optional: `MODEL` (default `gpt-4o-mini`), `PORT`, `DB_PATH`.

## Tradeoffs and limits (honest)

| Choice | Why | Limitation |
|--------|-----|------------|
| Hand-rolled ReAct loop | Full control; easy to read and explain | Not as battle-tested as LangChain/AutoGen; max 6 steps is a hard ceiling |
| SQLite (single file) | Zero config, works with `npm install` immediately | One process at a time (WAL helps), no multi-user concurrency by design |
| FTS5 keyword search | Simple, robust, no embedding model or vector DB | No semantic search — "CRM tools" won't match "customer relationship management" |
| In-memory search cache | Zero infra | Cache lost on restart; not shared across server instances |
| `gpt-4o-mini` default | Fast, cheap, strong tool use | Complex multi-hop research may benefit from a larger model; set `MODEL` accordingly |
| Serper | Simple JSON API, good results | One search provider; if the key is missing the agent degrades to "search unavailable" and answers from its own knowledge |

## How the examples are handled

- **CRM pricing/shipping since Monday** → model searches web for each shortlisted tool + "pricing" / "launch"; memory excerpts tell it which tools were shortlisted.
- **What did I ask on 3 November?** → FTS/date lookup finds that day's messages; model quotes them; optional second search checks if the answer still holds.
- **Postgres hosting pricing since last Tuesday** → date math from "today" in the system prompt + FTS finds the old Postgres thread; search checks current pricing pages.

## Running

```
cp .env.example .env   # fill in OPENAI_API_KEY and SERPER_API_KEY
npm install
npm run dev            # node --watch src/server.js
```

Open `http://localhost:3000`.
