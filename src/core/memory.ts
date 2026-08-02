/**
 * Memory Mechanism — two deliberately decoupled pipelines (memory_mechanism.md)
 *
 * 1. In-conversation: context window mgmt. Always-on fold + watermark-triggered compact.
 *    Strategies explicit. Recovery channel = special tool (intercepted).
 * 2. Across-conversation: user profile for SP. Security boundary at wire: force owner, fail-close.
 *
 * Off by default. Cache hits not misses.
 */
import {
  ConversationHistory, ProcessedMessage, CompactionStrategy, ToolDef,
} from './types.js';
import { HistoryProcessor } from './history.js';
import { countTokens } from '../utils/tokens.js';

export interface InConvMemoryConfig {
  foldStrategy: CompactionStrategy;
  compactWatermark: number; // when prior prompt tokens > this, compact
  // prefix length kept on fold
  keepPrefixLen?: number;
}

export interface AcrossConvMemoryConfig {
  enabled: boolean;
}

export class InConversationMemory {
  // Per-request default storage. Real production: injectable backend.
  // Shared between fold writer and recovery reader by construction.
  private storage: Map<string, string> = new Map();
  private recoveryToolName = 'recall_folded_memory';
  // monotonic counter for ref ids — deterministic, not Date.now() (idempotency).
  private refCounter = 0;

  constructor(
    private processor: HistoryProcessor,
    private cfg: InConvMemoryConfig = { foldStrategy: CompactionStrategy.NONE, compactWatermark: 60000 }
  ) {}

  /**
   * Always-on fold every round on tool responses.
   * For prefix_with_ref: generate ref + populate recovery store IN THE SAME CALL.
   * Idempotent: already-folded messages are skipped.
   */
  applyFold(hist: ConversationHistory): void {
    if (this.cfg.foldStrategy === CompactionStrategy.NONE) return;

    const keepLen = this.cfg.keepPrefixLen ?? 280;

    if (this.cfg.foldStrategy === CompactionStrategy.PREFIX_WITH_REF) {
      // Fold both prefix (settled history) and suffix (in-flight) tool results.
      hist.prefix = hist.prefix.map(m => this.foldOneWithRef(m, keepLen));
      hist.suffix = hist.suffix.map(m => this.foldOneWithRef(m, keepLen));
      return;
    }

    // For other strategies, delegate to the pure version on the processor.
    hist.prefix = this.processor.applyFoldStrategy(hist.prefix, this.cfg.foldStrategy, keepLen);
    hist.suffix = this.processor.applyFoldStrategy(hist.suffix, this.cfg.foldStrategy, keepLen);
  }

  private foldOneWithRef(m: ProcessedMessage, keepLen: number): ProcessedMessage {
    if (m.role !== 'tool') return m;
    if ((m as any)._folded) return m; // idempotent

    const orig = m.content || '';
    if (orig.length <= keepLen) {
      // nothing to fold; mark to avoid re-checking
      (m as any)._folded = true;
      return m;
    }

    const ref = `ref:${++this.refCounter}`;
    this.storage.set(ref, orig);

    const copy: ProcessedMessage = { ...m };
    copy.content = orig.slice(0, keepLen) + `… [folded; call ${this.recoveryToolName} with ref="${ref}" to recover full content]`;
    copy.tokens = countTokens(copy.content) + 4;
    (copy as any).recoveryRef = ref;
    (copy as any)._folded = true;
    return copy;
  }

  /**
   * Watermark-triggered compact: only fires when previous prompt token count
   * exceeded the configured threshold. Compacts WITHIN the prefix only — the
   * monotonic slice line (history_processing.md §1) survives unchanged.
   *
   * 4-step shape: collapse → check → drop oldest pairs → reverse-restore what fits.
   */
  async maybeCompact(hist: ConversationHistory, lastPromptTokens: number): Promise<boolean> {
    if (lastPromptTokens <= this.cfg.compactWatermark) return false;

    const target = this.cfg.compactWatermark * 0.7;
    let prefixTokens = hist.prefix.reduce((s, m) => s + m.tokens, 0);
    const suffixTokens = hist.suffix.reduce((s, m) => s + m.tokens, 0);
    let totalTokens = prefixTokens + suffixTokens;

    if (totalTokens <= target) return false;

    // Drop from the OLDEST end of the prefix only. Suffix is the in-flight
    // react cycle and is never touched.
    const dropped: ProcessedMessage[] = [];
    while (totalTokens > target && hist.prefix.length > 0) {
      const oldest = hist.prefix.shift()!;
      dropped.push(oldest);
      prefixTokens -= oldest.tokens;
      totalTokens -= oldest.tokens;
    }

    // Reverse-restore: try to add back from newest-dropped until budget is tight.
    // (4-step algorithm: gives back recency that still fits.)
    while (dropped.length > 0) {
      const candidate = dropped[dropped.length - 1];
      if (totalTokens + candidate.tokens > this.cfg.compactWatermark) break;
      hist.prefix.unshift(dropped.pop()!);
      totalTokens += candidate.tokens;
    }

    return true;
  }

  /** Recovery tool handler. Intercepted before middleware/real tools. */
  getRecoveryToolHandler() {
    return async (args: any): Promise<string> => {
      const ref = args?.ref || args?.recovery_ref;
      if (!ref) return 'No ref provided';
      const content = this.storage.get(String(ref));
      return content ?? '[recovery content not found or expired]';
    };
  }

  /** Tool definition exposed to the LLM (memory_mechanism.md §5). */
  getRecoveryToolDef(): ToolDef {
    return {
      name: this.recoveryToolName,
      description: 'Recall the full original content of a previously folded tool result by its recovery reference (e.g. "ref:3"). Use only when the prefix you can see is insufficient.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'The recovery reference shown in the folded message' } },
        required: ['ref'],
      },
      // Handler is overridden by the loop's interception path; this is here so
      // the framework can register it like any other tool.
      handler: async (args) => {
        const ref = (args as any)?.ref;
        if (!ref) return 'No ref provided';
        return this.storage.get(String(ref)) ?? '[recovery content not found or expired]';
      },
    };
  }

  /** Stable name for the recovery tool — consumers (loop) match against this. */
  getRecoveryToolName(): string {
    return this.recoveryToolName;
  }

  /** Whether folding is active for this request. */
  isActive(): boolean {
    return this.cfg.foldStrategy !== CompactionStrategy.NONE;
  }
}

export class AcrossConversationMemory {
  private cache = new Map<string, Record<string, string>>(); // success cache only

  constructor(
    private fetcher?: (userId: string) => Promise<Record<string, string>>,
    /**
     * Optional pending-write queue. When set, writeMemory() stages the
     * write here instead of (or in addition to) calling fetcher's
     * underlying store. The CLI uses this to require user confirmation
     * before persisting model-proposed memories — see
     * memory_mechanism.md §6 ("treat the model as an adversary").
     */
    private pendingQueue?: PendingWriteQueue,
    /**
     * Optional direct persistence path. When provided AND no pendingQueue
     * is set, writeMemory() persists immediately (still with owner forced).
     */
    private directWriter?: (entry: { owner: string; key: string; value: string }) => Promise<void>,
  ) {}

  /** Cache hits not misses */
  async fetchProfile(userId: string): Promise<Record<string, string>> {
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!;
    }
    if (!this.fetcher) {
      return {};
    }
    try {
      const profile = await this.fetcher(userId);
      this.cache.set(userId, profile); // success only
      return profile;
    } catch (e) {
      // do not cache failure
      return {};
    }
  }

  /** Inject into SP template vars */
  async getTemplateVars(userId: string): Promise<Record<string, string>> {
    const p = await this.fetchProfile(userId);
    return {
      user_name: p.name || 'User',
      user_preferences: typeof p.preferences === 'string' ? p.preferences : JSON.stringify(p.preferences || {}),
      ...p,
    };
  }

  /**
   * Security boundary for writes (memory_mechanism.md §6).
   * The runtime hits this with the request-derived owner; model arguments are
   * never trusted to set the owner. Fail-close on unparseable input.
   *
   * Routing:
   *   - pendingQueue present → stage for user confirmation, return a hint.
   *   - directWriter present → persist immediately.
   *   - neither → log and pretend it worked (backwards compat).
   */
  async writeMemory(ownerFromRequest: string, argsFromModel: any): Promise<{ success: boolean; error?: string; pendingId?: string }> {
    if (!argsFromModel || typeof argsFromModel !== 'object') {
      // fail-close: emit minimal safe args (owner only) rather than letting bad input through
      return { success: false, error: 'invalid args (fail-close)' };
    }
    const rawKey = (argsFromModel as any).key;
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      return { success: false, error: 'empty key' };
    }
    const safeArgs = {
      owner: ownerFromRequest, // FORCED, never trust model
      key: String(rawKey),
      value: String((argsFromModel as any).value || '').slice(0, 4000),
    };

    if (this.pendingQueue) {
      const pendingId = this.pendingQueue.stage(safeArgs);
      return {
        success: true,
        pendingId,
      };
    }
    if (this.directWriter) {
      await this.directWriter(safeArgs);
      return { success: true };
    }
    // Final fallback: log so it's auditable in noisy dev mode.
    // Keep this as console.log rather than the structured logger: the
    // framework is library-shaped and shouldn't depend on a logger being
    // wired. Real deployments inject a directWriter or pendingQueue.
    console.log('[AcrossMemory] write (no store wired) for owner=', safeArgs.owner, 'key=', safeArgs.key);
    return { success: true };
  }
}

/**
 * Pending-write confirmation queue.
 *
 * Each write_user_memory call enters here as a pending entry with a short
 * id. The CLI (or HTTP server) renders the queue to the user and accepts
 * or denies entries via the /memory slash command. Accepted entries flow
 * through to the real persistence layer; denied entries are forgotten.
 *
 * The queue is per-request — it doesn't survive a process exit. That's
 * intentional: an unconfirmed write should never persist.
 */
export interface PendingWrite {
  id: string;
  owner: string;
  key: string;
  value: string;
  stagedAt: string;
}

export class PendingWriteQueue {
  private items = new Map<string, PendingWrite>();
  private counter = 0;
  private clock: () => string;
  constructor(opts?: { now?: () => string }) {
    this.clock = opts?.now ?? (() => new Date().toISOString());
  }
  stage(entry: { owner: string; key: string; value: string }): string {
    const id = `pw_${++this.counter}`;
    this.items.set(id, { id, ...entry, stagedAt: this.clock() });
    return id;
  }
  list(): PendingWrite[] {
    return [...this.items.values()];
  }
  get(id: string): PendingWrite | undefined {
    return this.items.get(id);
  }
  /** Remove and return the entry. */
  take(id: string): PendingWrite | undefined {
    const e = this.items.get(id);
    if (e) this.items.delete(id);
    return e;
  }
  drop(id: string): boolean {
    return this.items.delete(id);
  }
  clear(): void {
    this.items.clear();
  }
  size(): number { return this.items.size; }
}
