/**
 * Cross-conversation user memory store.
 *
 * Stores standing facts about a user — preferences, recurring context,
 * project info — that the agent should remember across sessions.
 *
 * Two implementations:
 *   - MemoryUserMemoryStore (in-memory; for tests + --no-persist)
 *   - SqliteUserMemoryStore (shares the same DB as sessions)
 *
 * The store is intentionally simple: a flat (owner, key) → value map.
 * Owner is the user id and the security boundary. Callers MUST pass the
 * request's user id; the store never trusts model-supplied owners.
 *
 * Confirmation flow:
 *   - The write_user_memory tool stages a *pending* write keyed by a
 *     short id. The CLI surfaces it; /memory accept <id> promotes it to
 *     a real entry. /memory deny <id> drops it. Unaccepted entries are
 *     in-process only and die with the REPL.
 *   - This matches the "treat the model as an adversary at security
 *     boundaries" discipline from memory_mechanism.md §6.
 */

export interface MemoryEntry {
  owner: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemoryStore {
  /** Get a single entry. */
  get(owner: string, key: string): Promise<MemoryEntry | undefined>;
  /** List all entries for an owner. Newest-first by updatedAt. */
  list(owner: string): Promise<MemoryEntry[]>;
  /** Upsert. Owner is always trusted from the caller, never from value/key. */
  set(owner: string, key: string, value: string): Promise<MemoryEntry>;
  /** Delete a single key. Returns true on hit. */
  forget(owner: string, key: string): Promise<boolean>;
  /** Delete all entries for an owner. Returns the count removed. */
  clear(owner: string): Promise<number>;
  /** Release any resources (sqlite handle, etc). Idempotent. */
  close?(): void;
}

// ── In-memory implementation ───────────────────────────────────────────

export class InMemoryUserMemoryStore implements UserMemoryStore {
  private records = new Map<string, MemoryEntry>(); // key = `${owner}\0${key}`
  private clock: () => string;

  constructor(opts?: { now?: () => string }) {
    this.clock = opts?.now ?? (() => new Date().toISOString());
  }

  private mkKey(owner: string, key: string): string { return `${owner}\0${key}`; }

  async get(owner: string, key: string): Promise<MemoryEntry | undefined> {
    const e = this.records.get(this.mkKey(owner, key));
    return e ? { ...e } : undefined;
  }

  async list(owner: string): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = [];
    for (const [k, v] of this.records) {
      if (k.startsWith(owner + '\0')) out.push({ ...v });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async set(owner: string, key: string, value: string): Promise<MemoryEntry> {
    const now = this.clock();
    const existing = this.records.get(this.mkKey(owner, key));
    const entry: MemoryEntry = {
      owner, key, value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(this.mkKey(owner, key), entry);
    return { ...entry };
  }

  async forget(owner: string, key: string): Promise<boolean> {
    return this.records.delete(this.mkKey(owner, key));
  }

  async clear(owner: string): Promise<number> {
    let removed = 0;
    for (const k of [...this.records.keys()]) {
      if (k.startsWith(owner + '\0')) { this.records.delete(k); removed++; }
    }
    return removed;
  }

  close(): void {
    this.records.clear();
  }
}
