/**
 * In-memory session store. Used by tests and `--no-persist`.
 *
 * The store deep-copies on read and on write so callers can mutate without
 * fear (defensive-copy discipline from state_and_lifecycle §3).
 */
import type {
  SessionStore, SessionRecord, SessionSummary, SessionMetaPatch, UsageDelta,
} from './session-store.js';
import { deriveTitle } from './session-store.js';
import type { RawMessage } from '../core/types.js';

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();
  private clock: () => string;

  constructor(opts?: { now?: () => string }) {
    this.clock = opts?.now ?? (() => new Date().toISOString());
  }

  async create(input: Omit<SessionRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: string; updatedAt?: string;
  }): Promise<SessionRecord> {
    if (this.records.has(input.id)) {
      throw new Error(`session ${input.id} already exists`);
    }
    const now = this.clock();
    const rec: SessionRecord = {
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      title: input.title ?? deriveTitle(input.messages),
    };
    this.records.set(rec.id, clone(rec));
    return clone(rec);
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const r = this.records.get(id);
    return r ? clone(r) : undefined;
  }

  async appendMessages(id: string, messages: RawMessage[]): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new Error(`session ${id} not found`);
    // Idempotency: only append entries beyond the current length. Callers
    // pass the full history; we keep the tail.
    if (messages.length < r.messages.length) {
      throw new Error(`appendMessages: shorter than stored history (${messages.length} < ${r.messages.length})`);
    }
    const tail = messages.slice(r.messages.length);
    if (tail.length === 0) return;
    r.messages.push(...tail.map(m => clone(m)));
    r.updatedAt = this.clock();
    if (!r.title || r.title === '(empty session)') {
      r.title = deriveTitle(r.messages);
    }
  }

  async recordUsage(id: string, delta: UsageDelta): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new Error(`session ${id} not found`);
    r.usage.promptTokens += delta.promptTokens ?? 0;
    r.usage.completionTokens += delta.completionTokens ?? 0;
    r.usage.toolCalls += delta.toolCalls ?? 0;
    r.usage.rounds += delta.rounds ?? 0;
    r.updatedAt = this.clock();
  }

  async updateMeta(id: string, patch: SessionMetaPatch): Promise<void> {
    const r = this.records.get(id);
    if (!r) throw new Error(`session ${id} not found`);
    for (const k of Object.keys(patch) as (keyof SessionMetaPatch)[]) {
      const v = patch[k];
      if (v !== undefined) (r as any)[k] = clone(v);
    }
    r.updatedAt = this.clock();
  }

  async list(opts?: { limit?: number; profile?: string }): Promise<SessionSummary[]> {
    const limit = opts?.limit ?? 50;
    const all = [...this.records.values()];
    const filtered = opts?.profile ? all.filter(r => r.profile === opts.profile) : all;
    filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filtered.slice(0, limit).map(r => toSummary(r));
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  close(): void {
    this.records.clear();
  }
}

function toSummary(r: SessionRecord): SessionSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    profile: r.profile,
    model: r.model,
    messageCount: r.messages.length,
    tokensTotal: r.usage.promptTokens + r.usage.completionTokens,
    title: r.title ?? '(empty session)',
  };
}
