/**
 * Per-session in-flight lock + abort registry.
 *
 * Two things to coordinate per session:
 *   1. Concurrency cap: at most one POST .../messages may run at a time.
 *      The second POST returns 409 with a `running: <requestId>` hint.
 *   2. Cancellation: the cancel endpoint signals the running request's
 *      AbortController so the loop bails out.
 */

export interface SessionRun {
  requestId: string;
  abort: AbortController;
  startedAt: number;
}

export class SessionRunLock {
  private runs = new Map<string, SessionRun>();

  /** Returns true if the session is free, false if a run is in flight. */
  tryAcquire(sessionId: string, requestId: string): { ok: true; abort: AbortController } | { ok: false; conflict: SessionRun } {
    const existing = this.runs.get(sessionId);
    if (existing) return { ok: false, conflict: existing };
    const abort = new AbortController();
    this.runs.set(sessionId, { requestId, abort, startedAt: Date.now() });
    return { ok: true, abort };
  }

  release(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  /** Returns true if a run was aborted, false if nothing was in flight. */
  abort(sessionId: string, reason?: Error): boolean {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    run.abort.abort(reason ?? new Error('cancelled by client'));
    return true;
  }

  /** All active runs (for SIGTERM drain). */
  activeRuns(): SessionRun[] {
    return [...this.runs.values()];
  }

  /** Number of in-flight runs. */
  size(): number { return this.runs.size; }
}
