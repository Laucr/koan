/**
 * M7 tests — cross-conversation memory:
 *   - UserMemoryStore (in-memory + sqlite) parity
 *   - SqliteSessionStore migration v2 adds user_memory table
 *   - AcrossConversationMemory.writeMemory routing (queue / direct / fallback)
 *   - PendingWriteQueue lifecycle
 *   - memoryFetcherFor produces the expected SP variables
 *   - /memory slash commands
 *   - end-to-end: write_user_memory stages → /memory accept persists →
 *     next-turn SP includes the memory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  InMemoryUserMemoryStore, SqliteUserMemoryStore, SqliteSessionStore,
  memoryFetcherFor,
  type UserMemoryStore,
  PendingWriteQueue, AcrossConversationMemory,
} from '../src/index.js';
import { runReActAgent, registerTool, createAgentConfig, TerminationReason } from '../src/index.js';
import { writeUserMemoryTool } from '../src/index.js';
import type { LLMClient } from '../src/index.js';
import { handleSlash } from '../src/cli/slash.js';
import { ReplSession } from '../src/cli/session.js';

let tmpdir: string;
beforeAll(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m7-'));
  // The runtime intercepts write_user_memory by its `isMemoryWrite` flag;
  // the loop still needs to look up the ToolDef by name. Register it once.
  try { registerTool(writeUserMemoryTool); } catch { /* already registered */ }
});

// ── store parity ────────────────────────────────────────────────────────

const STORES: Array<{ name: string; make: () => Promise<{ store: UserMemoryStore; cleanup: () => void }> }> = [
  {
    name: 'InMemoryUserMemoryStore',
    make: async () => ({ store: new InMemoryUserMemoryStore(), cleanup: () => {} }),
  },
  {
    name: 'SqliteUserMemoryStore',
    make: async () => {
      const dir = await fs.mkdtemp(path.join(tmpdir, 'mem-'));
      const filePath = path.join(dir, 'memory.db');
      const store = new SqliteUserMemoryStore({ filePath });
      return { store, cleanup: () => store.close() };
    },
  },
];

for (const variant of STORES) {
  describe(variant.name, () => {
    it('set / get / list / forget / clear', async () => {
      const { store, cleanup } = await variant.make();
      try {
        const a = await store.set('alice', 'preferred_style', 'terse');
        expect(a.owner).toBe('alice');
        const back = await store.get('alice', 'preferred_style');
        expect(back?.value).toBe('terse');

        await store.set('alice', 'project_dir', '/x');
        const list = await store.list('alice');
        expect(list.map(e => e.key).sort()).toEqual(['preferred_style', 'project_dir']);

        expect(await store.forget('alice', 'preferred_style')).toBe(true);
        expect(await store.forget('alice', 'missing')).toBe(false);

        const removed = await store.clear('alice');
        expect(removed).toBe(1);
        expect((await store.list('alice')).length).toBe(0);
      } finally {
        cleanup();
      }
    });

    it('owners are isolated', async () => {
      const { store, cleanup } = await variant.make();
      try {
        await store.set('alice', 'k', 'A');
        await store.set('bob', 'k', 'B');
        expect((await store.get('alice', 'k'))?.value).toBe('A');
        expect((await store.get('bob', 'k'))?.value).toBe('B');
        await store.clear('alice');
        expect((await store.get('bob', 'k'))?.value).toBe('B');
      } finally {
        cleanup();
      }
    });

    it('set on existing key updates value, preserves createdAt', async () => {
      const { store, cleanup } = await variant.make();
      try {
        const a = await store.set('u', 'k', 'v1');
        await new Promise(r => setTimeout(r, 5));
        const b = await store.set('u', 'k', 'v2');
        expect(b.value).toBe('v2');
        expect(b.createdAt).toBe(a.createdAt);
        expect(b.updatedAt >= a.updatedAt).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
}

// ── migration ───────────────────────────────────────────────────────────

describe('SqliteSessionStore migration v2', () => {
  it('user_memory table is created on a fresh DB', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir, 'mig-'));
    const dbPath = path.join(dir, 'sessions.db');
    const store = new SqliteSessionStore({ filePath: dbPath });
    store.close();
    const db = new Database(dbPath);
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[];
    db.close();
    const names = rows.map(r => r.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('user_memory');
  });

  it('opening an old v1-only DB applies v2 (table appears)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir, 'mig-old-'));
    const dbPath = path.join(dir, 'sessions.db');
    // Build a v1 snapshot by hand.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (session_id TEXT, ordinal INTEGER, role TEXT, content TEXT, PRIMARY KEY (session_id, ordinal));
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '${new Date().toISOString()}', 'initial schema');
    `);
    db.close();
    // Open with the real store — should run migration v2.
    const store = new SqliteSessionStore({ filePath: dbPath });
    store.close();
    const db2 = new Database(dbPath);
    const row = db2.prepare(`SELECT version FROM schema_migrations WHERE version = 2`).get() as any;
    const userMem = db2.prepare(`SELECT name FROM sqlite_master WHERE name = 'user_memory'`).get() as any;
    db2.close();
    expect(row?.version).toBe(2);
    expect(userMem?.name).toBe('user_memory');
  });
});

// ── PendingWriteQueue ───────────────────────────────────────────────────

describe('PendingWriteQueue', () => {
  it('stage / list / take', () => {
    const q = new PendingWriteQueue();
    const id1 = q.stage({ owner: 'u', key: 'k', value: 'v' });
    const id2 = q.stage({ owner: 'u', key: 'j', value: 'w' });
    expect(q.size()).toBe(2);
    expect(q.list().map(e => e.id)).toEqual([id1, id2]);
    const taken = q.take(id1);
    expect(taken?.key).toBe('k');
    expect(q.size()).toBe(1);
    expect(q.take(id1)).toBeUndefined();
  });

  it('drop / clear', () => {
    const q = new PendingWriteQueue();
    const id = q.stage({ owner: 'u', key: 'k', value: 'v' });
    expect(q.drop(id)).toBe(true);
    expect(q.drop(id)).toBe(false);
    q.stage({ owner: 'u', key: 'a', value: 'b' });
    q.stage({ owner: 'u', key: 'c', value: 'd' });
    q.clear();
    expect(q.size()).toBe(0);
  });
});

// ── AcrossConversationMemory routing ────────────────────────────────────

describe('AcrossConversationMemory.writeMemory routing', () => {
  it('queues to PendingWriteQueue when one is set, returning pendingId', async () => {
    const q = new PendingWriteQueue();
    const m = new AcrossConversationMemory(undefined, q);
    const r = await m.writeMemory('alice', { key: 'k', value: 'v' });
    expect(r.success).toBe(true);
    expect(r.pendingId).toBeDefined();
    expect(q.size()).toBe(1);
  });

  it('calls direct writer when no queue', async () => {
    const calls: any[] = [];
    const m = new AcrossConversationMemory(
      undefined,
      undefined,
      async (entry) => { calls.push(entry); },
    );
    const r = await m.writeMemory('alice', { key: 'k', value: 'v' });
    expect(r.success).toBe(true);
    expect(r.pendingId).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ owner: 'alice', key: 'k', value: 'v' });
  });

  it('forces owner from request, ignoring model-supplied owner', async () => {
    const captured: any[] = [];
    const m = new AcrossConversationMemory(
      undefined, undefined,
      async (entry) => { captured.push(entry); },
    );
    await m.writeMemory('alice', { owner: 'bob', key: 'k', value: 'v' });
    expect(captured[0].owner).toBe('alice');
  });

  it('fails closed on bad args', async () => {
    const m = new AcrossConversationMemory(undefined, new PendingWriteQueue());
    expect((await m.writeMemory('a', null as any)).success).toBe(false);
    expect((await m.writeMemory('a', 'x' as any)).success).toBe(false);
  });

  it('empty key is rejected', async () => {
    const m = new AcrossConversationMemory(undefined, new PendingWriteQueue());
    const r = await m.writeMemory('a', { key: '', value: 'x' });
    expect(r.success).toBe(false);
  });
});

// ── memoryFetcherFor ────────────────────────────────────────────────────

describe('memoryFetcherFor', () => {
  it('renders an empty store as "(none)"', async () => {
    const store = new InMemoryUserMemoryStore();
    const fetcher = memoryFetcherFor(store);
    const vars = await fetcher('alice');
    expect(vars.user_memories).toBe('(none)');
    expect(vars.user_memories_count).toBe('0');
  });

  it('renders entries as a bulleted list', async () => {
    const store = new InMemoryUserMemoryStore();
    await store.set('alice', 'style', 'terse');
    await store.set('alice', 'project', '/foo');
    const fetcher = memoryFetcherFor(store);
    const vars = await fetcher('alice');
    expect(vars.user_memories).toMatch(/- style: terse/);
    expect(vars.user_memories).toMatch(/- project: \/foo/);
    expect(vars.user_memories_count).toBe('2');
    expect(vars.mem_style).toBe('terse');
    expect(vars.mem_project).toBe('/foo');
  });

  it('isolates by owner', async () => {
    const store = new InMemoryUserMemoryStore();
    await store.set('alice', 'k', 'A');
    await store.set('bob', 'k', 'B');
    const fetcher = memoryFetcherFor(store);
    expect((await fetcher('alice')).user_memories).toMatch(/- k: A/);
    expect((await fetcher('bob')).user_memories).toMatch(/- k: B/);
  });
});

// ── /memory slash ───────────────────────────────────────────────────────

function mkReplSession() {
  return new ReplSession({
    initialPermissions: new Set(['read']),
    model: 'gpt-x',
    provider: 'openai',
  });
}

describe('/memory slash commands', () => {
  it('no args lists stored entries', async () => {
    const store = new InMemoryUserMemoryStore();
    await store.set('local', 'k', 'v');
    const r = await handleSlash('/memory', {
      session: mkReplSession(),
      memoryStore: store,
    });
    expect(r.message).toMatch(/k\s+v/);
  });

  it('"pending" lists pending writes', async () => {
    const q = new PendingWriteQueue();
    q.stage({ owner: 'local', key: 'k', value: 'v' });
    const r = await handleSlash('/memory pending', {
      session: mkReplSession(),
      pendingMemoryWrites: q,
    });
    expect(r.message).toMatch(/pw_\d+\s+k\s+v/);
  });

  it('accept persists a pending write', async () => {
    const store = new InMemoryUserMemoryStore();
    const q = new PendingWriteQueue();
    const id = q.stage({ owner: 'local', key: 'k', value: 'v' });
    const r = await handleSlash(`/memory accept ${id}`, {
      session: mkReplSession(), memoryStore: store, pendingMemoryWrites: q,
    });
    expect(r.kind).toBe('continue');
    expect((await store.get('local', 'k'))?.value).toBe('v');
    expect(q.size()).toBe(0);
  });

  it('deny drops a pending write without persisting', async () => {
    const store = new InMemoryUserMemoryStore();
    const q = new PendingWriteQueue();
    const id = q.stage({ owner: 'local', key: 'k', value: 'v' });
    await handleSlash(`/memory deny ${id}`, {
      session: mkReplSession(), memoryStore: store, pendingMemoryWrites: q,
    });
    expect(await store.get('local', 'k')).toBeUndefined();
    expect(q.size()).toBe(0);
  });

  it('forget removes a stored memory', async () => {
    const store = new InMemoryUserMemoryStore();
    await store.set('local', 'k', 'v');
    await handleSlash('/memory forget k', { session: mkReplSession(), memoryStore: store });
    expect(await store.get('local', 'k')).toBeUndefined();
  });

  it('clear empties everything for the current user', async () => {
    const store = new InMemoryUserMemoryStore();
    await store.set('local', 'a', '1');
    await store.set('local', 'b', '2');
    await store.set('other-user', 'x', '9');
    await handleSlash('/memory clear', { session: mkReplSession(), memoryStore: store });
    expect((await store.list('local')).length).toBe(0);
    expect((await store.list('other-user')).length).toBe(1);
  });

  it('reports a clean error when store is not wired', async () => {
    const r = await handleSlash('/memory forget k', { session: mkReplSession() });
    expect(r.kind).toBe('error');
  });
});

// ── end-to-end: write through the loop ─────────────────────────────────

describe('end-to-end: write_user_memory stages and accepts', () => {
  it('the loop intercepts, queue receives the entry, slash /memory accept persists', async () => {
    const q = new PendingWriteQueue();
    const store = new InMemoryUserMemoryStore();

    let phase = 0;
    const llm: LLMClient = async (req) => {
      phase++;
      if (phase === 1) {
        return {
          message: {
            content: 'remembering',
            tool_calls: [{ id: 'c1', function: { name: 'write_user_memory', arguments: JSON.stringify({ key: 'style', value: 'bullet points' }) } }],
          },
        };
      }
      return { message: { content: 'done', tool_calls: undefined } };
    };

    const result = await runReActAgent({
      agentConfig: createAgentConfig({ name: 'm7', maxRounds: 4, tools: ['write_user_memory'] }),
      llm,
      userId: 'alice',
      initialMessages: [{ role: 'user', content: 'remember my style is bullet points' }],
      pendingMemoryWrites: q,
    });

    // Tool result told the model the write is pending.
    const all = [...result.history.prefix, ...result.history.suffix];
    expect(all.some((m: any) => m.role === 'tool' && /pending: write staged as pw_\d+/.test(String(m.content)))).toBe(true);

    expect(q.size()).toBe(1);
    const id = q.list()[0].id;

    // Accept via /memory accept …
    const slash = await handleSlash(`/memory accept ${id}`, {
      session: mkReplSession(),
      memoryStore: store,
      pendingMemoryWrites: q,
      userId: 'alice', // important: same owner the queue staged under
    });
    expect(slash.kind).toBe('continue');
    expect((await store.get('alice', 'style'))?.value).toBe('bullet points');
  });
});
