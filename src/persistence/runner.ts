/**
 * Session runner — wraps runReActAgent + a SessionStore so the CLI/REPL
 * don't have to know the persistence shape.
 *
 *   - Caller creates a record up-front (or resumes one).
 *   - After every turn, the runner persists the new tail and the usage delta.
 *
 * The runner is provider-agnostic: feed it any LLMClient / LLMStreamingClient.
 */
import { runReActAgent } from '../core/loop.js';
import type {
  AgentConfig, RawMessage, LLMResponse, LLMClient,
} from '../core/types.js';
import type { LLMStreamEvent, LLMStreamingClient } from '../core/streaming.js';
import type { ToolApprover } from '../core/loop.js';
import type { ToolPermission, ToolGateMode } from '../core/types.js';
import type { SessionStore, SessionRecord } from './session-store.js';
import type { PendingWriteQueue } from '../core/memory.js';
import { getMetrics } from '../obs/metrics.js';
import { costFor } from '../obs/cost.js';
import type { TranscriptSink, NewTranscriptEvent } from '../transcript/types.js';
import { newTranscriptEvent } from '../transcript/koan.js';
import type { AgentLifecycleEvent } from '../core/events.js';

export interface RunTurnOptions {
  store: SessionStore;
  sessionId: string;
  /** The flat raw history to send into runReActAgent. Usually session.messages
   *  plus the new user message. */
  history: RawMessage[];
  agentConfig: AgentConfig;
  llm?: LLMClient;
  streamLLM?: LLMStreamingClient;
  onStreamEvent?: (e: LLMStreamEvent) => void;
  userId: string;
  signal?: AbortSignal;
  llmTimeoutMs?: number;
  permissions: Set<ToolPermission>;
  toolApprover?: ToolApprover;
  cwd: string;
  allowedPaths: string[];
  initialSearchGate?: ToolGateMode;
  /** Optional canonical JSONL sink. Events flush only after SQLite succeeds. */
  transcript?: TranscriptSink;
  /** Across-conv memory fetcher; piped into runReActAgent. */
  userMemoryFetcher?: (uid: string) => Promise<Record<string, string>>;
  /** Pending-write confirmation queue for write_user_memory. */
  pendingMemoryWrites?: PendingWriteQueue;
  /** Direct memory writer (used when bypassing confirmation). */
  memoryWriter?: (entry: { owner: string; key: string; value: string }) => Promise<void>;
}

export interface RunTurnResult {
  finalAnswer: string;
  /** The new tail the store now holds. */
  newMessages: RawMessage[];
  toolCallsMade: number;
  rounds: number;
  warnings: string[];
  usage: { promptTokens: number; completionTokens: number };
  termination: string;
}

/**
 * Run a single turn against the configured LLM, then persist:
 *   - new messages (appended in order)
 *   - usage delta (tokens, tool calls, rounds)
 */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  // Capture usage from the underlying adapter. We don't have streaming
  // adapters that report it consistently yet (M9 will tighten that). We
  // approximate by inspecting the assistant messages' length AFTER the run.
  let promptTokens = 0;
  let completionTokens = 0;
  const metrics = getMetrics();
  const startedAt = Date.now();
  const profileName = opts.agentConfig.name;
  const modelName = opts.agentConfig.model;
  const turnId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const transcriptEvents: NewTranscriptEvent[] = [];
  if (opts.transcript) {
    transcriptEvents.push(newTranscriptEvent('turn.started', {}, { turnId }));
    const userMessage = [...opts.history].reverse().find(message => message.role === 'user');
    if (userMessage) {
      transcriptEvents.push(newTranscriptEvent('message.user', {
        content: userMessage.content,
        ...(userMessage.media?.length ? { media: userMessage.media } : {}),
      }, { turnId }));
    }
  }

  const captureLifecycle = (event: AgentLifecycleEvent): void => {
    if (!opts.transcript) return;
    if (event.type === 'assistant_message') {
      transcriptEvents.push(newTranscriptEvent('message.assistant', {
        content: event.content,
        round: event.round,
        ...(event.toolCalls?.length ? { tool_calls: event.toolCalls } : {}),
      }, { timestamp: event.timestamp, turnId }));
    } else if (event.type === 'tool_started') {
      transcriptEvents.push(newTranscriptEvent('tool.started', {
        call_id: event.id,
        name: event.name,
        arguments: event.arguments,
        round: event.round,
      }, { timestamp: event.timestamp, turnId }));
    } else {
      transcriptEvents.push(newTranscriptEvent('tool.completed', {
        call_id: event.id,
        name: event.name,
        arguments: event.arguments,
        content: event.content,
        status: event.error ? 'failed' : 'completed',
        duration_ms: event.durationMs,
        round: event.round,
      }, { timestamp: event.timestamp, turnId }));
    }
  };

  const result = await runReActAgent({
    agentConfig: opts.agentConfig,
    llm: opts.llm,
    streamLLM: opts.streamLLM,
    onStreamEvent: opts.onStreamEvent ? (e) => {
      opts.onStreamEvent!(e);
      // Capture usage if the adapter surfaces it via the `done` event.
      if (e.type === 'done' && e.response.usage) {
        promptTokens += e.response.usage.prompt_tokens;
        completionTokens += e.response.usage.completion_tokens;
      }
    } : undefined,
    onLifecycleEvent: captureLifecycle,
    userId: opts.userId,
    initialMessages: opts.history,
    signal: opts.signal,
    llmTimeoutMs: opts.llmTimeoutMs,
    permissions: opts.permissions,
    toolApprover: opts.toolApprover,
    cwd: opts.cwd,
    allowedPaths: opts.allowedPaths,
    initialGate: opts.initialSearchGate ? { search: opts.initialSearchGate } : undefined,
    userMemoryFetcher: opts.userMemoryFetcher,
    pendingMemoryWrites: opts.pendingMemoryWrites,
    memoryWriter: opts.memoryWriter,
  });
  if (promptTokens === 0 && completionTokens === 0 && result.usage) {
    promptTokens = result.usage.promptTokens;
    completionTokens = result.usage.completionTokens;
  }

  // Convert the loop's ProcessedMessage history back to RawMessage and diff
  // against `opts.history` to extract the new tail.
  const fullProcessed = [...result.history.prefix, ...result.history.suffix];
  const tail = fullProcessed.slice(opts.history.length).map((m): RawMessage => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
  }));

  // Persist: append tail, then bump usage. Order matters — appendMessages
  // bumps updatedAt anyway, and we want both updates to land even if the
  // process dies between them.
  if (tail.length > 0) {
    await opts.store.appendMessages(opts.sessionId, [...opts.history, ...tail]);
  }
  await opts.store.recordUsage(opts.sessionId, {
    promptTokens,
    completionTokens,
    toolCalls: result.toolCallsMade,
    rounds: result.rounds,
  });

  const warnings = [...result.warnings];
  if (opts.transcript) {
    transcriptEvents.push(newTranscriptEvent('turn.completed', {
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
      rounds: result.rounds,
      tool_calls: result.toolCallsMade,
      termination_reason: result.termination,
    }, { turnId }));
    try {
      await opts.transcript.append(transcriptEvents);
    } catch (error: any) {
      warnings.push(`transcript incomplete at ${opts.transcript.path}: ${error?.message || error}`);
    }
  }

  // Metrics emission. `outcome` is best-effort — the loop's structured
  // termination reason is the canonical signal; we encode it loosely here.
  const durationSec = (Date.now() - startedAt) / 1000;
  metrics.counter('koan_rounds_total', { profile: profileName, model: modelName }, result.rounds, 'Total ReAct rounds executed.');
  if (result.toolCallsMade > 0) {
    metrics.counter('koan_tool_calls_total', { tool: 'any', outcome: 'ok' }, result.toolCallsMade, 'Total tool calls executed.');
  }
  if (promptTokens) metrics.counter('koan_tokens_total', { kind: 'prompt', model: modelName }, promptTokens, 'Tokens consumed.');
  if (completionTokens) metrics.counter('koan_tokens_total', { kind: 'completion', model: modelName }, completionTokens, 'Tokens consumed.');
  const usd = costFor(modelName, promptTokens, completionTokens);
  if (usd !== null && usd > 0) {
    metrics.counter('koan_cost_usd_total', { model: modelName }, usd, 'Estimated USD cost.');
  }
  metrics.observe('koan_round_duration_seconds', { profile: profileName, model: modelName }, durationSec, 'Wall-clock per turn.');

  return {
    finalAnswer: result.finalAnswer,
    newMessages: tail,
    toolCallsMade: result.toolCallsMade,
    rounds: result.rounds,
    warnings,
    usage: { promptTokens, completionTokens },
    termination: result.termination,
  };
}

/**
 * Convert a SessionRecord into the flat history the loop's `initialMessages`
 * expects. Defensive copy.
 */
export function recordToInitialMessages(record: SessionRecord): RawMessage[] {
  return record.messages.map(m => ({ ...m }));
}
