/**
 * REPL session state — the conversation memory that survives across turns.
 *
 * The REPL keeps a flat `RawMessage[]` and hands it to `runReActAgent` as
 * `initialMessages` each turn. After the loop returns, we extract the
 * incremental tail (everything the loop appended to the suffix) and merge
 * it back into the canonical raw history. The slice line is re-derived by
 * the loop on every call, per the philosophy.
 *
 * Save/load uses a small JSON envelope so the format can evolve without
 * breaking older session files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  RawMessage, ProcessedMessage, ConversationHistory, ToolPermission,
} from '../core/types.js';

export const SESSION_FORMAT_VERSION = 1;

export interface SessionEnvelope {
  version: number;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  permissions: ToolPermission[];
  history: RawMessage[];
}

export class ReplSession {
  // Canonical history. Always in raw form (no token cache attached); the
  // loop converts it on every turn.
  private history: RawMessage[] = [];
  private permissions: Set<ToolPermission>;
  public model: string;
  public provider: string;

  constructor(opts: {
    initialPermissions: Set<ToolPermission>;
    model: string;
    provider: string;
  }) {
    this.permissions = new Set(opts.initialPermissions);
    this.model = opts.model;
    this.provider = opts.provider;
  }

  /** Snapshot the raw history (defensive copy). */
  getHistory(): RawMessage[] {
    return this.history.map(m => ({ ...m }));
  }

  /** Current permissions (defensive copy). */
  getPermissions(): Set<ToolPermission> {
    return new Set(this.permissions);
  }

  /** Replace permissions wholesale (used by `/permissions set ...`). */
  setPermissions(p: Iterable<ToolPermission>): void {
    this.permissions = new Set(p);
  }

  /** Toggle one permission on/off. */
  togglePermission(p: ToolPermission): boolean {
    if (this.permissions.has(p)) { this.permissions.delete(p); return false; }
    this.permissions.add(p); return true;
  }

  /** Append a user message to start a new turn. */
  appendUserMessage(content: string): void {
    this.history.push({ role: 'user', content });
  }

  /**
   * After a run completes, fold the loop's resulting ConversationHistory
   * back into our flat raw form. The loop sees `initialMessages` (= our
   * history before this turn) and appends assistant + tool messages to the
   * suffix. We diff and append the tail.
   */
  mergeRunResult(resultHistory: ConversationHistory): void {
    const all: ProcessedMessage[] = [...resultHistory.prefix, ...resultHistory.suffix];
    // Drop the prefix-of-our-prior-history that the loop already saw.
    // `all` shape: prior raw messages converted to ProcessedMessage, then
    // new assistant/tool messages appended. Our cursor is `this.history`'s
    // length BEFORE merge.
    const priorLen = this.history.length;
    const tail = all.slice(priorLen);
    for (const m of tail) {
      // Don't bring along the `tokens`/`isInSuffix` fields — they're
      // round-local. Re-derive next turn.
      const raw: RawMessage = { role: m.role, content: m.content };
      if (m.toolCalls && m.toolCalls.length) raw.toolCalls = m.toolCalls;
      if (m.toolCallId) raw.toolCallId = m.toolCallId;
      this.history.push(raw);
    }
  }

  /** /clear — wipe history but keep permission grants and model. */
  clear(): void {
    this.history = [];
  }

  /** /history summary (one line per message, truncated). */
  describe(): string {
    if (this.history.length === 0) return '(empty)';
    const out: string[] = [];
    this.history.forEach((m, i) => {
      const preview = String(m.content || '').replace(/\s+/g, ' ').slice(0, 80);
      const meta = m.toolCalls?.length ? ` [+${m.toolCalls.length} tool call${m.toolCalls.length === 1 ? '' : 's'}]` : '';
      out.push(`${String(i).padStart(3)}  ${m.role.padEnd(10)} ${preview}${meta}`);
    });
    return out.join('\n');
  }

  toEnvelope(): SessionEnvelope {
    return {
      version: SESSION_FORMAT_VERSION,
      createdAt: new Date().toISOString(), // best-effort; real persistence (M6) does this properly
      updatedAt: new Date().toISOString(),
      model: this.model,
      provider: this.provider,
      permissions: [...this.permissions],
      history: this.getHistory(),
    };
  }

  loadEnvelope(env: SessionEnvelope): void {
    if (env.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`Unsupported session format version: ${env.version} (this build understands ${SESSION_FORMAT_VERSION})`);
    }
    this.history = env.history.map(m => ({ ...m }));
    this.permissions = new Set(env.permissions);
    if (env.model) this.model = env.model;
    if (env.provider) this.provider = env.provider;
  }
}

/** Write a session envelope to disk as pretty JSON. */
export async function saveSession(session: ReplSession, filePath: string): Promise<void> {
  const env = session.toEnvelope();
  const abs = path.resolve(filePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(env, null, 2), 'utf8');
}

/** Read a session envelope and apply it to an existing session. */
export async function loadSession(session: ReplSession, filePath: string): Promise<void> {
  const abs = path.resolve(filePath);
  const raw = await fs.readFile(abs, 'utf8');
  const parsed: SessionEnvelope = JSON.parse(raw);
  session.loadEnvelope(parsed);
}
