/**
 * SQLite-backed session store.
 *
 * Schema lives across two tables plus a migrations bookkeeping row:
 *
 *   sessions(id PK, created_at, updated_at, profile, provider, model, cwd,
 *            permissions JSON, usage JSON, title, tags JSON)
 *   messages(session_id FK, ordinal, role, content, tool_calls JSON,
 *            tool_call_id, PRIMARY KEY (session_id, ordinal))
 *
 * Migrations are applied at open. Each migration is idempotent and runs
 * in a transaction. Adding a migration: append to MIGRATIONS, never edit.
 *
 * The store is synchronous under the hood (better-sqlite3) but exposes
 * an async interface to match SessionStore.
 */
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as Db } from 'better-sqlite3';
import type {
  SessionStore, SessionRecord, SessionSummary, SessionMetaPatch, UsageDelta,
} from './session-store.js';
import { deriveTitle } from './session-store.js';
import type { RawMessage, ToolPermission } from '../core/types.js';

interface Migration {
  version: number;
  description: string;
  up: (db: Db) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema (sessions + messages)',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id           TEXT PRIMARY KEY,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          profile      TEXT NOT NULL,
          provider     TEXT NOT NULL,
          model        TEXT NOT NULL,
          cwd          TEXT NOT NULL,
          permissions  TEXT NOT NULL,   -- JSON array
          usage        TEXT NOT NULL,   -- JSON object
          title        TEXT,
          tags         TEXT             -- JSON array, nullable
        );
        CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
          session_id   TEXT NOT NULL,
          ordinal      INTEGER NOT NULL,
          role         TEXT NOT NULL,
          content      TEXT NOT NULL,
          tool_calls   TEXT,             -- JSON array, nullable
          tool_call_id TEXT,
          PRIMARY KEY (session_id, ordinal),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, ordinal);
      `);
    },
  },
  {
    version: 2,
    description: 'cross-conversation user memory',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_memory (
          owner       TEXT NOT NULL,
          key         TEXT NOT NULL,
          value       TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (owner, key)
        );
        CREATE INDEX IF NOT EXISTS user_memory_owner_updated
          ON user_memory(owner, updated_at DESC);
      `);
    },
  },
];

export interface SqliteStoreOptions {
  filePath: string;
  now?: () => string;
}

export class SqliteSessionStore implements SessionStore {
  private db: Db;
  private clock: () => string;
  private closed = false;

  constructor(opts: SqliteStoreOptions) {
    fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
    this.db = new Database(opts.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.clock = opts.now ?? (() => new Date().toISOString());
    applyMigrations(this.db);
  }

  async create(input: Omit<SessionRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: string; updatedAt?: string;
  }): Promise<SessionRecord> {
    const now = this.clock();
    const rec: SessionRecord = {
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      title: input.title ?? deriveTitle(input.messages),
    };
    const txn = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sessions(id, created_at, updated_at, profile, provider, model, cwd, permissions, usage, title, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rec.id, rec.createdAt, rec.updatedAt, rec.profile, rec.provider, rec.model, rec.cwd,
        JSON.stringify(rec.permissions),
        JSON.stringify(rec.usage),
        rec.title ?? null,
        rec.tags ? JSON.stringify(rec.tags) : null,
      );
      const ins = this.db.prepare(`
        INSERT INTO messages(session_id, ordinal, role, content, tool_calls, tool_call_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      rec.messages.forEach((m, i) => {
        ins.run(
          rec.id, i, m.role,
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null,
        );
      });
    });
    try { txn(); }
    catch (e: any) {
      if (/UNIQUE constraint failed: sessions.id/.test(String(e?.message))) {
        throw new Error(`session ${rec.id} already exists`);
      }
      throw e;
    }
    return rec;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    const msgs = this.db.prepare(`
      SELECT ordinal, role, content, tool_calls, tool_call_id FROM messages
      WHERE session_id = ? ORDER BY ordinal ASC
    `).all(id) as any[];
    return rowToRecord(row, msgs);
  }

  async appendMessages(id: string, messages: RawMessage[]): Promise<void> {
    const existing = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).get(id) as any;
    if (!existing) throw new Error(`session ${id} not found`);
    const n: number = existing.n;
    if (messages.length < n) {
      throw new Error(`appendMessages: shorter than stored history (${messages.length} < ${n})`);
    }
    const tail = messages.slice(n);
    if (tail.length === 0) return;
    const now = this.clock();
    const txn = this.db.transaction(() => {
      const ins = this.db.prepare(`
        INSERT INTO messages(session_id, ordinal, role, content, tool_calls, tool_call_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      tail.forEach((m, i) => {
        ins.run(
          id, n + i, m.role,
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null,
        );
      });
      // Keep title in sync if it was the default empty placeholder.
      this.db.prepare(`UPDATE sessions SET updated_at = ?,
        title = COALESCE(NULLIF(title, '(empty session)'), ?)
        WHERE id = ?`).run(now, deriveTitle(messages), id);
    });
    txn();
  }

  async recordUsage(id: string, delta: UsageDelta): Promise<void> {
    const row = this.db.prepare(`SELECT usage FROM sessions WHERE id = ?`).get(id) as any;
    if (!row) throw new Error(`session ${id} not found`);
    const current = JSON.parse(row.usage) as SessionRecord['usage'];
    const updated: SessionRecord['usage'] = {
      promptTokens: current.promptTokens + (delta.promptTokens ?? 0),
      completionTokens: current.completionTokens + (delta.completionTokens ?? 0),
      toolCalls: current.toolCalls + (delta.toolCalls ?? 0),
      rounds: current.rounds + (delta.rounds ?? 0),
    };
    this.db.prepare(`UPDATE sessions SET usage = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(updated), this.clock(), id);
  }

  async updateMeta(id: string, patch: SessionMetaPatch): Promise<void> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    if (!row) throw new Error(`session ${id} not found`);
    const next = {
      profile: patch.profile ?? row.profile,
      provider: patch.provider ?? row.provider,
      model: patch.model ?? row.model,
      cwd: patch.cwd ?? row.cwd,
      permissions: patch.permissions ? JSON.stringify(patch.permissions) : row.permissions,
      title: patch.title ?? row.title,
      tags: patch.tags ? JSON.stringify(patch.tags) : row.tags,
    };
    this.db.prepare(`UPDATE sessions SET profile = ?, provider = ?, model = ?, cwd = ?,
      permissions = ?, title = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
      next.profile, next.provider, next.model, next.cwd, next.permissions,
      next.title, next.tags, this.clock(), id,
    );
  }

  async list(opts?: { limit?: number; profile?: string }): Promise<SessionSummary[]> {
    const limit = opts?.limit ?? 50;
    const rows = opts?.profile
      ? this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS msg_count
                         FROM sessions s WHERE profile = ? ORDER BY updated_at DESC LIMIT ?`)
            .all(opts.profile, limit) as any[]
      : this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS msg_count
                         FROM sessions s ORDER BY updated_at DESC LIMIT ?`)
            .all(limit) as any[];
    return rows.map(r => {
      const usage = JSON.parse(r.usage);
      return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        profile: r.profile,
        model: r.model,
        messageCount: r.msg_count,
        tokensTotal: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
        title: r.title ?? '(empty session)',
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    // FK cascade handles messages.
    const r = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

function applyMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    description TEXT NOT NULL
  )`);
  const applied = new Set<number>();
  for (const row of db.prepare(`SELECT version FROM schema_migrations`).all() as any[]) {
    applied.add(row.version);
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const txn = db.transaction(() => {
      m.up(db);
      db.prepare(`INSERT INTO schema_migrations(version, applied_at, description) VALUES (?, ?, ?)`)
        .run(m.version, new Date().toISOString(), m.description);
    });
    txn();
  }
}

function rowToRecord(row: any, msgs: any[]): SessionRecord {
  const messages: RawMessage[] = msgs.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { toolCalls: JSON.parse(m.tool_calls) } : {}),
    ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
  }));
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profile: row.profile,
    provider: row.provider,
    model: row.model,
    cwd: row.cwd,
    permissions: JSON.parse(row.permissions) as ToolPermission[],
    usage: JSON.parse(row.usage),
    messages,
    title: row.title ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
  };
}

/** Default file path: $XDG_DATA_HOME/koan/sessions.db (or ~/.local/share/...). */
export function defaultSessionsDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME
    || path.join(process.env.HOME || process.cwd(), '.local', 'share');
  return path.join(xdg, 'koan', 'sessions.db');
}
