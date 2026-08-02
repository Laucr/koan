/**
 * Approval coordinator — turns the in-process `ToolApprover` callback into
 * an asynchronous HTTP round-trip.
 *
 * The server's message handler installs a coordinator-backed approver on
 * every run. When the loop hits a permission-gated tool call, it suspends
 * on `coordinator.request(...)`. The server emits an `approval_needed`
 * SSE event. The client POSTs `/v1/sessions/:sid/approvals/:pid` with
 * `{ decision: "allow" | "deny" | "always" }`; the coordinator's pending
 * promise resolves and the loop continues.
 *
 * One coordinator is shared across the whole server. Pending requests are
 * keyed by `${sessionId}/${pendingId}` so a stale POST against a different
 * session can't satisfy another session's approval.
 */
import type { ToolApproval } from '../core/loop.js';

interface PendingApproval {
  resolve: (decision: ToolApproval) => void;
  timeoutId: NodeJS.Timeout;
  toolName: string;
}

export interface RequestOpts {
  sessionId: string;
  toolName: string;
  /** ms before the request auto-denies. */
  timeoutMs?: number;
}

export interface ApprovalEvent {
  /** Opaque id the client sends back in the resolution POST. */
  pendingId: string;
  toolName: string;
  /** Pre-formatted preview (truncated JSON). */
  argsPreview: string;
  /** ms until auto-deny. Client should warn the user before this elapses. */
  timeoutMs: number;
}

export class ApprovalCoordinator {
  private counter = 0;
  private pending = new Map<string, PendingApproval>();

  /**
   * Wait for the client to approve or deny a tool call. Emits the
   * approval-needed event by calling the provided emitter. Returns the
   * verdict (auto-deny on timeout).
   */
  request(
    opts: RequestOpts & {
      argsPreview: string;
      emit: (event: ApprovalEvent) => void;
    },
  ): Promise<ToolApproval> {
    const pendingId = `ap_${++this.counter}`;
    const key = `${opts.sessionId}/${pendingId}`;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<ToolApproval>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(key);
        resolve('deny');
      }, timeoutMs);
      this.pending.set(key, { resolve, timeoutId, toolName: opts.toolName });
      opts.emit({
        pendingId, toolName: opts.toolName, argsPreview: opts.argsPreview, timeoutMs,
      });
    });
  }

  /**
   * Resolve a pending approval. Returns true if a request was waiting,
   * false if the id was unknown or stale.
   */
  resolveById(sessionId: string, pendingId: string, decision: ToolApproval): boolean {
    const key = `${sessionId}/${pendingId}`;
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timeoutId);
    this.pending.delete(key);
    entry.resolve(decision);
    return true;
  }

  /** Cancel everything for a session (used on session DELETE). */
  cancelSession(sessionId: string): number {
    let n = 0;
    for (const [k, v] of this.pending) {
      if (k.startsWith(sessionId + '/')) {
        clearTimeout(v.timeoutId);
        v.resolve('deny');
        this.pending.delete(k);
        n++;
      }
    }
    return n;
  }

  size(): number { return this.pending.size; }
}

/** Helper: format args for the SSE event without leaking huge payloads. */
export function previewArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch {
    return '<unprintable>';
  }
}
