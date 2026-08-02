/**
 * Session persistence contract.
 *
 * A `SessionRecord` is one durable conversation. It's a deliberately small
 * shape: just enough for the CLI to render a list, the REPL to rehydrate,
 * and `koan sessions show` to dump the full transcript.
 *
 * Two implementations ship:
 *   - MemorySessionStore (default for tests + --no-persist)
 *   - SqliteSessionStore (file at ~/.local/share/koan/sessions.db)
 *
 * The interface is sparse-update friendly (state_and_lifecycle §7):
 *   - `create` sets the immutable fields.
 *   - `appendMessages` appends to the message log; idempotent on `id`.
 *   - `recordUsage` adds tokens to the running totals without overwriting.
 *   - `updateMeta` is partial — undefined keys are left alone.
 *
 * Schema evolves through `applyMigrations`; the SQLite store stores its
 * current version in a `schema_migrations` table.
 */
import type { RawMessage, ToolPermission } from '../core/types.js';

export interface SessionRecord {
  id: string;
  createdAt: string;     // ISO timestamp
  updatedAt: string;
  profile: string;       // profile name
  provider: string;
  model: string;
  cwd: string;
  /** Granted permissions at session start. May drift over the session via /permissions. */
  permissions: ToolPermission[];
  /** Running totals across the session. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    toolCalls: number;
    rounds: number;
  };
  /** Flat conversation history, monotonic per the philosophy. */
  messages: RawMessage[];
  /** Free-form tags. */
  tags?: string[];
  /** Optional short label, defaults to the first user message preview. */
  title?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  profile: string;
  model: string;
  messageCount: number;
  tokensTotal: number;
  title: string;
}

/** Sparse update for SessionRecord top-level metadata. */
export interface SessionMetaPatch {
  profile?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  permissions?: ToolPermission[];
  title?: string;
  tags?: string[];
}

/** Incremental usage delta. Each call adds to the running totals. */
export interface UsageDelta {
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: number;
  rounds?: number;
}

export interface SessionStore {
  /** Insert a new record. Throws if `id` already exists. */
  create(record: Omit<SessionRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: string; updatedAt?: string;
  }): Promise<SessionRecord>;
  /** Look up by id. Returns undefined when not found. */
  get(id: string): Promise<SessionRecord | undefined>;
  /** Append new messages. The store dedups by content+role+index if `messages`
   *  is a strict superset of what was already stored (idempotency for retries). */
  appendMessages(id: string, messages: RawMessage[]): Promise<void>;
  /** Add to running usage totals. */
  recordUsage(id: string, delta: UsageDelta): Promise<void>;
  /** Sparse metadata update. */
  updateMeta(id: string, patch: SessionMetaPatch): Promise<void>;
  /** List sessions, newest first. `limit` defaults to 50. */
  list(opts?: { limit?: number; profile?: string }): Promise<SessionSummary[]>;
  /** Delete a session and its children. Returns true when something was deleted. */
  delete(id: string): Promise<boolean>;
  /** Close any open resources. Idempotent. */
  close(): void;
}

/** Generate a short opaque session id. Time-prefixed for sort stability. */
export function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `s_${ts}_${rnd}`;
}

/** Build a one-line preview from the first user message. */
export function deriveTitle(messages: RawMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  if (!first) return '(empty session)';
  const text = typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}
