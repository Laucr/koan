/**
 * SQLite-backed UserMemoryStore.
 *
 * Reuses the sessions database — opening the same file applies any pending
 * migrations (idempotent), so callers don't need to worry about which store
 * "owns" the schema.
 */
import path from 'node:path';
import fs from 'node:fs';
import Database, { type Database as Db } from 'better-sqlite3';
import type { MemoryEntry, UserMemoryStore } from './user-memory-store.js';

export interface SqliteUserMemoryStoreOptions {
  filePath: string;
  now?: () => string;
}

export class SqliteUserMemoryStore implements UserMemoryStore {
  private db: Db;
  private clock: () => string;
  private closed = false;

  constructor(opts: SqliteUserMemoryStoreOptions) {
    fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
    this.db = new Database(opts.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.clock = opts.now ?? (() => new Date().toISOString());
    // Migrations: open the sessions store side-effect once. To keep this
    // file independent we apply our own minimal migration if the table is
    // missing — applyMigrations is idempotent inside SqliteSessionStore
    // anyway, so opening a sessions store on the same file is also safe.
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
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
  }

  async get(owner: string, key: string): Promise<MemoryEntry | undefined> {
    const row = this.db.prepare(`SELECT * FROM user_memory WHERE owner = ? AND key = ?`)
      .get(owner, key) as any;
    return row ? toEntry(row) : undefined;
  }

  async list(owner: string): Promise<MemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM user_memory WHERE owner = ? ORDER BY updated_at DESC
    `).all(owner) as any[];
    return rows.map(toEntry);
  }

  async set(owner: string, key: string, value: string): Promise<MemoryEntry> {
    const now = this.clock();
    const existing = this.db.prepare(`SELECT created_at FROM user_memory WHERE owner = ? AND key = ?`).get(owner, key) as any;
    const createdAt = existing?.created_at ?? now;
    this.db.prepare(`
      INSERT INTO user_memory(owner, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(owner, key, value, createdAt, now);
    return { owner, key, value, createdAt, updatedAt: now };
  }

  async forget(owner: string, key: string): Promise<boolean> {
    const r = this.db.prepare(`DELETE FROM user_memory WHERE owner = ? AND key = ?`).run(owner, key);
    return r.changes > 0;
  }

  async clear(owner: string): Promise<number> {
    const r = this.db.prepare(`DELETE FROM user_memory WHERE owner = ?`).run(owner);
    return r.changes;
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

function toEntry(row: any): MemoryEntry {
  return {
    owner: row.owner,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
