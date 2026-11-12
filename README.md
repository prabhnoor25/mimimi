# mimimi — chat agent with web search

A chat agent with one tool (web search), persistent dated memory, and streaming responses. Built for the minimi hiring challenge.

## Quick start

```bash
cp .env.example .env
# edit .env and add OPENAI_API_KEY and SERPER_API_KEY
npm install
npm run dev          # node --watch src/server.js
```

Open http://localhost:3000.

`npm start` runs without watch for production.

## Required keys (`.env.example`)

| Key | Purpose |
|-----|---------|
| `OPENAI_API_KEY` | Chat model + tool calling (OpenAI or any OpenAI-compatible endpoint) |
| `SERPER_API_KEY` | Web search via Serper.dev |

Optional: `OPENAI_BASE_URL`, `MODEL` (default `gpt-4o-mini`), `PORT`, `DB_PATH`.

## Project layout

```
src/server.js   Express server + SSE chat endpoint
src/agent.js    ReAct agent loop (web_search, fetch_url), max 6 steps
src/search.js   Serper search + page fetch, both cached (1h TTL)
src/db.js       SQLite + FTS5: conversations, messages, dated keyword search
public/         Vanilla JS frontend, SSE client, tiny markdown renderer
DESIGN.md       Architecture and tradeoff decisions
```

## What it does

- Answers questions using web search when they're time-sensitive ("has pricing changed since…?")
- Remembers past conversations by date ("what did I ask on 3 November?", "last Tuesday…")
- Streams answers token-by-token via SSE so it feels fast
- Runs searches in parallel when several are useful in one turn

## Notes

- No build step: plain ESM JavaScript on Node ≥ 20.
- If API keys are missing, the app still starts but the agent reports a clear configuration error instead of failing silently.
- See `DESIGN.md` for the full design and known tradeoffs.
