/**
 * State & Lifecycle implementation (state_and_lifecycle.md)
 * Layered lifetimes, orthogonal sub-states, defensive copies on read,
 * signal lifetimes tagged, round-end hook owns cleanup, sparse updates via callbacks.
 * Hot path is "single threaded" by construction: the loop awaits sequentially.
 */
import {
  AgentSessionState, ControlSignals, ConversationHistory,
  SignalLifetime, StatusCallback, TerminationReason,
} from './types.js';
import { deepCopy as dc } from '../utils/defensive.js';

export class ConversationState {
  private state: AgentSessionState;
  private statusCb?: StatusCallback;

  // No unified lock: substates separate, hot writes are sequential in loop
  constructor(initial: Partial<AgentSessionState> & { conversationId: string; userId: string; agentName: string }) {
    this.state = {
      round: 0,
      toolContext: { cursors: {}, artifacts: {} },
      signals: {
        searchGate: { mode: 'auto', oneShot: true },
      },
      // searchGate's lifetime is special: see roundEndCleanup. Other signals
      // declare lifetime via setSignal.
      signalLifetimes: {},
      history: initial.history || { prefix: [], suffix: [], nextMediaId: { image: 0, video: 0, document: 0 } },
      ...initial,
    } as AgentSessionState;
    // ensure required fields are not clobbered by spread
    if (!this.state.signalLifetimes) this.state.signalLifetimes = {};
    if (!this.state.signals) this.state.signals = { searchGate: { mode: 'auto', oneShot: true } };
  }

  setStatusCallback(cb: StatusCallback) {
    this.statusCb = cb;
  }

  // --- Readers always defensive copy ---
  getSnapshot(): AgentSessionState {
    return dc(this.state);
  }

  getRound(): number { return this.state.round; }

  getHistorySnapshot(): ConversationHistory {
    return dc(this.state.history);
  }

  // Writers are called only from the sequential loop
  incrementRound() {
    this.state.round += 1;
    this.fireStatus({ status: 'round_start', round: this.state.round });
  }

  appendToSuffix(msgs: any[]) {
    // In practice the history processor manages, but state holds the live
    this.state.history.suffix.push(...msgs);
  }

  // Signals API: declare lifetime at set time. Round-end iterates the
  // lifetime map; new signals just need to declare their lifetime once.
  setSignal<K extends keyof ControlSignals>(
    key: K,
    value: ControlSignals[K],
    lifetime: SignalLifetime
  ) {
    (this.state.signals as any)[key] = value;
    (this.state.signalLifetimes as any)[key] = lifetime;
  }

  getSignals(): ControlSignals {
    return dc(this.state.signals);
  }

  // Round end cleanup hook — the ONE place that knows lifetimes.
  // Iterates the declared signalLifetimes map; nothing hardcoded.
  roundEndCleanup() {
    const sig = this.state.signals;
    const lifetimes = this.state.signalLifetimes;

    for (const key of Object.keys(lifetimes) as (keyof ControlSignals)[]) {
      const lt = lifetimes[key];
      if (lt === 'one-shot') {
        delete (sig as any)[key];
        delete (lifetimes as any)[key];
      }
      // session-wide / monotonic: leave alone.
      // derived: never stored, so won't appear here.
    }

    // searchGate has a special structure: oneShot is encoded in the value
    // itself (force is one-shot, forbid is session-wide). This matches
    // tool_vs_llm_decision.md §4: one-shot vs session-wide is a safety property.
    if (sig.searchGate?.oneShot) {
      sig.searchGate = { mode: 'auto', oneShot: true };
    }

    this.fireStatus({ status: 'round_end', round: this.state.round });
  }

  // Termination
  terminate(reason: TerminationReason) {
    this.state.terminated = { reason, atRound: this.state.round };
    this.fireStatus({ status: 'terminated', reason, round: this.state.round });
  }

  isTerminated(): boolean {
    return !!this.state.terminated;
  }

  getTermination() {
    return this.state.terminated;
  }

  // Sparse update style for persistence
  updateStatusSparse(patch: Partial<{ lastStatus: string; progress: number }>) {
    if (patch.lastStatus !== undefined) this.state.lastStatus = patch.lastStatus;
    if (patch.progress !== undefined) this.state.progress = patch.progress;
    if (this.statusCb) {
      this.statusCb({ status: this.state.lastStatus || 'update', progress: this.state.progress });
    }
  }

  private fireStatus(u: any) {
    if (this.statusCb) this.statusCb(u);
  }

  // Tool context access (defensive)
  getToolContextSnapshot() {
    return dc(this.state.toolContext);
  }

  recordArtifact(key: string, value: unknown) {
    this.state.toolContext.artifacts[key] = value;
  }

  // For memory compaction access (in place mutate of history ok because sequential)
  getMutableHistory() {
    return this.state.history;
  }
}
