import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Sqlite from 'better-sqlite3';

/**
 * Persistence layer for the chat agent.
 *
 * Schema:
 *   conversations  - one row per chat thread
 *   messages       - every user/assistant/tool message, timestamped
 *   messages_fts   - FTS5 full-text index over message content (so a user can
 *                    ask "what did I ask about Postgres last Tuesday?" and we
 *                    can actually find it)
 *
 * All timestamps are epoch milliseconds. better-sqlite3 is synchronous, which
 * keeps this code simple and more than fast enough for a chat app.
 */
export class Database {
  constructor(dbPath) {
    // Auto-create the directory so `npm run dev` works out of the box.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Sqlite(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT,
        created_at INTEGER NOT NULL,
        tool_calls TEXT,   -- JSON, assistant messages only
        tool_call_id TEXT  -- tool messages only
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(created_at);
    `);

    // FTS5 is optional: some SQLite builds ship without it. If it isn't
    // available we fall back to LIKE search in searchMessages().
    this.hasFts = false;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(id, content);

        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(id, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, id, content) VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, id, content) VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts(id, content) VALUES (new.id, new.content);
        END;
      `);
      // Sanity-check that MATCH actually works.
      this.db.prepare('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?').get('__fts_sanity__');
      this.hasFts = true;
    } catch (err) {
      // FTS5 unavailable in this SQLite build; LIKE fallback handles it.
      this.hasFts = false;
    }
  }

  /** Create a conversation if it doesn't exist, otherwise touch updated_at. */
  ensureConversation(id) {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (existing) {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
      return existing;
    }
    this.db.prepare(
      'INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(id, 'New chat', now, now);
    return { id, title: 'New chat', created_at: now, updated_at: now };
  }

  listConversations() {
    return this.db
      .prepare(
        'SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100'
      )
      .all();
  }

  messageCount(conversationId) {
    return this.db
      .prepare('SELECT count(*) AS n FROM messages WHERE conversation_id = ?')
      .get(conversationId).n;
  }

  maybeSetTitle(conversationId, firstUserMessage) {
    const count = this.messageCount(conversationId);
    const current = this.db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId);
    if (count === 1 && current.title === 'New chat' && firstUserMessage) {
      this.db.prepare(
        'UPDATE conversations SET title = ? WHERE id = ?'
      ).run(firstUserMessage.slice(0, 60), conversationId);
    }
  }

  /**
   * Insert (or replace) a message. used for user, assistant and tool messages.
   */
  upsertMessage({ id, conversationId, role, content, createdAt, toolCalls, toolCallId }) {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO messages(id, conversation_id, role, content, created_at, tool_calls, tool_call_id)
         VALUES (@id, @conversationId, @role, @content, @createdAt, @toolCalls, @toolCallId)
         ON CONFLICT(id) DO UPDATE SET
           role = excluded.role,
           content = excluded.content,
           created_at = excluded.created_at,
           tool_calls = excluded.tool_calls,
           tool_call_id = excluded.tool_call_id`
      ).run({
        id,
        conversationId,
        role,
        content,
        createdAt: createdAt || Date.now(),
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        toolCallId: toolCallId || null,
      });
      this.db.prepare(
        'UPDATE conversations SET updated_at = ? WHERE id = ?'
      ).run(Date.now(), conversationId);
    });
    tx();
  }

  /** Most recent `limit` messages of a conversation, oldest first. */
  getMessages(conversationId, limit = 50) {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(conversationId, limit)
      .reverse();
  }

  /**
   * Full-text search over past messages. Returns matches with their date so the
   * agent can answer "what did I ask on 3 November?" style questions.
   * Searches across all conversations (this is a personal assistant).
   */
  searchMessages(query, limit = 6) {
    const clean = query.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
    if (!clean.length) return [];

    if (this.hasFts) {
      const ftsQuery = clean.join(' ');
      return this.db
        .prepare(
          `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
           FROM messages m
           JOIN messages_fts f ON m.id = f.id
           WHERE messages_fts MATCH ?
           ORDER BY bm25(messages_fts)
           LIMIT ?`
        )
        .all(ftsQuery, limit);
    }

    const like = `%${clean.join('%')}%`;
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(like, limit);
  }

  /** Messages of a conversation on a specific calendar date (ISO YYYY-MM-DD). */
  getMessagesOnDate(conversationId, dateIso) {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND date(created_at / 1000, 'unixepoch') = ?
         ORDER BY created_at ASC`
      )
      .all(conversationId, dateIso);
  }

  close() {
    this.db.close();
  }
}
