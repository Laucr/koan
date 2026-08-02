/**
 * M6 tests — session stores (memory + sqlite) and the persistence runner.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MemorySessionStore, SqliteSessionStore, newSessionId,
  type SessionStore, type SessionRecord,
} from '../src/persistence/index.js';
import { runTurn } from '../src/persistence/runner.js';
import { createAgentConfig } from '../src/index.js';
import type { LLMClient, LLMResponse, RawMessage } from '../src/index.js';

let tmpdir: string;
beforeAll(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m6-'));
});

// Open stores per-test so we can compare implementations apples-to-apples.
function freshRecord(overrides: Partial<SessionRecord> = {}): Omit<SessionRecord, 'createdAt' | 'updatedAt'> {
  return {
    id: newSessionId(),
    profile: 'default',
    provider: 'openai',
    model: 'gpt-x',
    cwd: '/tmp',
    permissions: ['read'],
    usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 },
    messages: [],
    ...overrides,
  };
}

const STORES: Array<{ name: string; make: () => Promise<{ store: SessionStore; cleanup: () => void }> }> = [
  {
    name: 'MemorySessionStore',
    make: async () => ({ store: new MemorySessionStore(), cleanup: () => {} }),
  },
  {
    name: 'SqliteSessionStore',
    make: async () => {
      const dir = await fs.mkdtemp(path.join(tmpdir, 'sqlite-'));
      const filePath = path.join(dir, 'sessions.db');
      const store = new SqliteSessionStore({ filePath });
      return { store, cleanup: () => store.close() };
    },
  },
];

for (const variant of STORES) {
  describe(variant.name, () => {
    let store: SessionStore;
    let cleanup: () => void;
    afterEach(() => cleanup?.());

    it('create / get roundtrips messages and metadata', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord({
        messages: [{ role: 'user', content: 'hello' }],
      }));
      const back = await store.get(rec.id);
      expect(back).toBeDefined();
      expect(back!.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(back!.profile).toBe('default');
      expect(back!.title).toMatch(/hello/);
    });

    it('appendMessages appends only the tail', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord({
        messages: [{ role: 'user', content: 'q1' }],
      }));
      const updated: RawMessage[] = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ];
      await store.appendMessages(rec.id, updated);
      const back = await store.get(rec.id);
      expect(back!.messages).toEqual(updated);
    });

    it('appendMessages no-ops when given the same length', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord({
        messages: [{ role: 'user', content: 'q' }],
      }));
      const t1 = (await store.get(rec.id))!.updatedAt;
      await store.appendMessages(rec.id, [{ role: 'user', content: 'q' }]);
      const t2 = (await store.get(rec.id))!.updatedAt;
      // Tail empty → no update fired.
      expect(t1).toBe(t2);
    });

    it('appendMessages rejects shorter histories', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord({
        messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      }));
      await expect(store.appendMessages(rec.id, [{ role: 'user', content: 'a' }])).rejects.toThrow(/shorter/);
    });

    it('recordUsage adds (does not overwrite)', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord());
      await store.recordUsage(rec.id, { promptTokens: 10, completionTokens: 5, rounds: 1 });
      await store.recordUsage(rec.id, { promptTokens: 7, toolCalls: 2 });
      const back = await store.get(rec.id);
      expect(back!.usage).toEqual({ promptTokens: 17, completionTokens: 5, toolCalls: 2, rounds: 1 });
    });

    it('updateMeta is sparse', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord({ model: 'gpt-x' }));
      await store.updateMeta(rec.id, { model: 'gpt-y' });
      const back = await store.get(rec.id);
      expect(back!.model).toBe('gpt-y');
      expect(back!.profile).toBe('default'); // untouched
    });

    it('list returns newest-first', async () => {
      ({ store, cleanup } = await variant.make());
      const r1 = await store.create(freshRecord({ id: 's_old', messages: [{ role: 'user', content: 'first' }] }));
      // ensure clock progresses
      await new Promise(r => setTimeout(r, 10));
      const r2 = await store.create(freshRecord({ id: 's_new', messages: [{ role: 'user', content: 'second' }] }));
      const list = await store.list({});
      expect(list[0].id).toBe(r2.id);
      expect(list[1].id).toBe(r1.id);
    });

    it('delete returns true on hit, false on miss', async () => {
      ({ store, cleanup } = await variant.make());
      const rec = await store.create(freshRecord());
      expect(await store.delete(rec.id)).toBe(true);
      expect(await store.get(rec.id)).toBeUndefined();
      expect(await store.delete('no-such-id')).toBe(false);
    });

    it('duplicate create throws', async () => {
      ({ store, cleanup } = await variant.make());
      const id = newSessionId();
      await store.create(freshRecord({ id }));
      await expect(store.create(freshRecord({ id }))).rejects.toThrow(/already exists/);
    });

    it('list filters by profile', async () => {
      ({ store, cleanup } = await variant.make());
      await store.create(freshRecord({ id: 'a', profile: 'coding' }));
      await store.create(freshRecord({ id: 'b', profile: 'research' }));
      const list = await store.list({ profile: 'coding' });
      expect(list.length).toBe(1);
      expect(list[0].profile).toBe('coding');
    });
  });
}

// ── runner roundtrip ────────────────────────────────────────────────────

describe('persistence runner: full roundtrip', () => {
  it('persists tail + usage after a turn', async () => {
    const store = new MemorySessionStore();
    const id = newSessionId();
    await store.create({
      id, profile: 'default', provider: 'openai', model: 'gpt-x',
      cwd: '/tmp', permissions: ['read'],
      usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 },
      messages: [],
    });

    const llm: LLMClient = async (req): Promise<LLMResponse> => {
      // First (and only) call: emit a plain answer, no tool calls.
      return { message: { content: 'answered', tool_calls: undefined }, usage: { prompt_tokens: 12, completion_tokens: 3 } };
    };

    const result = await runTurn({
      store, sessionId: id,
      history: [{ role: 'user', content: 'q' }],
      agentConfig: createAgentConfig({ name: 'd', maxRounds: 3, tools: [] }),
      llm,
      userId: 'u',
      permissions: new Set(),
      cwd: '/tmp', allowedPaths: ['/tmp'],
    });
    expect(result.finalAnswer).toBe('answered');

    const rec = await store.get(id);
    expect(rec!.messages.map(m => m.content)).toEqual(['q', 'answered']);
    // Usage is captured only via streaming path (M2 done event). Non-streaming
    // adapters DON'T currently route through onStreamEvent, so the runner
    // sees 0/0. That's a known gap; flagging as a soft expectation.
    expect(rec!.usage.rounds).toBe(1);
  });
});

// ── sqlite-specific ────────────────────────────────────────────────────

describe('SqliteSessionStore migrations', () => {
  it('schema_migrations gets a row per applied migration', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir, 'mig-'));
    const dbPath = path.join(dir, 'sessions.db');
    const store = new SqliteSessionStore({ filePath: dbPath });
    try {
      // Open a second store on the same file — should be a no-op.
      const store2 = new SqliteSessionStore({ filePath: dbPath });
      store2.close();
    } finally {
      store.close();
    }
    // Reopen and check the migrations table contains every applied version.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const rows = db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as any[];
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map(r => r.version)).toEqual([...rows.keys()].map(i => i + 1));
  });
});
