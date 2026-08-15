/**
 * The ReAct Loop Orchestrator.
 * Drives LLM -> (gate) -> (mw) -> tools -> LLM ...
 * All per philosophy: structural, predictable, quality delegated.
 * Single sequential hot path (awaits in loop).
 */
import {
  AgentConfig, AgentRunResult, LLMClient, LLMRequest, LLMResponse,
  ToolDef, ToolCallRequest, ToolCallResult, TerminationReason,
  BuildContext, StatusCallback, CLEAN_TERMINATION, CompactionStrategy,
  ToolPermission,
} from './types.js';
import type { LLMStreamEvent, LLMStreamingClient } from './streaming.js';
import type { AgentLifecycleSubscriber } from './events.js';
import { ConversationState } from './state.js';
import { HistoryProcessor } from './history.js';
import { ToolGate } from './toolgate.js';
import { MiddlewareChain } from './middleware.js';
import { InConversationMemory, AcrossConversationMemory, PendingWriteQueue } from './memory.js';
import { checkTermination, llmResponseHasToolCalls } from './termination.js';
import { resolveAgentToolsAndMws, getTool } from './registry.js';
import { countMessageTokens } from '../utils/tokens.js';

export interface RunAgentOptions {
  agentConfig: AgentConfig;
  /** Non-streaming client. Either this or `streamLLM` must be provided. */
  llm?: LLMClient;
  /**
   * Streaming client. When provided, takes precedence over `llm`. Each
   * round subscribes to its event stream, forwards events to
   * `onStreamEvent`, then assembles the full LLMResponse from `done`.
   */
  streamLLM?: LLMStreamingClient;
  /** Subscriber for streaming events (text deltas, tool-call assembly). */
  onStreamEvent?: (e: LLMStreamEvent, ctx: { round: number }) => void;
  /** Provider-neutral completed agent activity for persistence/audit sinks. */
  onLifecycleEvent?: AgentLifecycleSubscriber;
  initialMessages?: any[]; // raw
  userId: string;
  conversationId?: string;
  statusCallback?: StatusCallback;
  // late bound user memory fetcher
  userMemoryFetcher?: (uid: string) => Promise<Record<string, string>>;
  // allow overriding default gate at start
  initialGate?: { search?: 'auto' | 'force' | 'forbid' };
  // Cancellation: the loop checks between rounds and forwards the signal to
  // the LLM adapter on every call. A consumer (CLI Ctrl-C handler, HTTP
  // server's request abort) wires this in.
  signal?: AbortSignal;
  // Per-LLM-call timeout in ms. Each round's call gets this budget.
  llmTimeoutMs?: number;

  // M3 — Tool permissions and approval.

  /**
   * Coarse-grained permissions granted for this run. A tool whose
   * `permission` is not in this set is refused before the handler runs.
   * Undefined or empty → no permissioned tools may run; tools with no
   * declared permission (framework-internal) still execute.
   */
  permissions?: ReadonlySet<ToolPermission>;
  /**
   * Optional per-call approval gate. Called BEFORE running any tool whose
   * permission is in the granted set (so this can ask "are you sure?" for
   * destructive tools even though the capability was statically granted).
   * Return `'allow'` to run, `'deny'` to refuse, or `'always'` to skip the
   * prompt for that tool name for the remainder of the run. A structured
   * `{ decision, reason? }` result can attach context to a denial.
   * A run with no approval callback proceeds for any permission that is
   * in `permissions`.
   */
  toolApprover?: ToolApprover;
  /** Working dir for fs.*-style tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Path allowlist for fs.*-style tools. Defaults to `[cwd]`. */
  allowedPaths?: string[];

  // M7 — Cross-conversation memory.

  /**
   * Optional pending-write queue. When set, write_user_memory calls stage
   * to this queue instead of persisting immediately. The CLI surfaces the
   * queue to the user via /memory accept|deny.
   */
  pendingMemoryWrites?: PendingWriteQueue;
  /**
   * Optional direct memory writer. Used when no pendingMemoryWrites is
   * set (e.g. --auto-approve all skipping confirmation). Receives the
   * sanitised entry; the runtime already forces `owner`.
   */
  memoryWriter?: (entry: { owner: string; key: string; value: string }) => Promise<void>;
}

export type ToolApprovalDecision = 'allow' | 'deny' | 'always';
export type ToolApproval = ToolApprovalDecision | {
  decision: ToolApprovalDecision;
  reason?: string;
};
export type ToolApprover = (req: {
  toolName: string;
  permission: ToolPermission;
  args: Record<string, unknown>;
  round: number;
}) => Promise<ToolApproval> | ToolApproval;

export async function runReActAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const cfg = opts.agentConfig;
  const { tools: agentTools, middlewareEntries } = resolveAgentToolsAndMws(cfg);

  const convId = opts.conversationId || `conv_${Date.now()}`;

  const histProc = new HistoryProcessor({
    tokenBudget: cfg.tokenBudget,
    slackTokens: cfg.slackTokens,
    aggressiveTruncateUserHead: false,
  });

  // Init history from initial (or empty), THEN attach to state via constructor —
  // no reach-into-private-fields hack.
  const rawInit = opts.initialMessages || [{ role: 'user', content: '(start)' }];
  const initHist = histProc.initHistory(rawInit as any);

  const state = new ConversationState({
    conversationId: convId,
    userId: opts.userId,
    agentName: cfg.name,
    history: initHist,
  });
  if (opts.statusCallback) state.setStatusCallback(opts.statusCallback);

  const gate = new ToolGate(cfg.defaultGate);
  if (opts.initialGate?.search) {
    const oneShot = opts.initialGate.search === 'force';
    gate.setSearchGate(opts.initialGate.search as any, oneShot);
    state.setSignal(
      'searchGate',
      { mode: opts.initialGate.search as any, oneShot },
      // force is one-shot, forbid is session-wide (tool_vs_llm_decision.md §4)
      oneShot ? 'one-shot' : 'session-wide'
    );
  }

  // Memory pipelines
  const inMemCfg = cfg.memory?.inConversation || { foldStrategy: CompactionStrategy.NONE, compactWatermark: 60000 };
  const inConvMem = new InConversationMemory(histProc, inMemCfg as any);

  const acrossMem = new AcrossConversationMemory(
    opts.userMemoryFetcher,
    opts.pendingMemoryWrites,
    opts.memoryWriter,
  );

  // Expose recovery tool to the LLM iff folding with refs is active.
  // Without this, the model can never call it and the recovery channel is dead.
  // (memory_mechanism.md §5)
  let effectiveTools = [...agentTools];
  let recoveryToolDef: ToolDef | null = null;
  if (inMemCfg.foldStrategy === CompactionStrategy.PREFIX_WITH_REF) {
    recoveryToolDef = inConvMem.getRecoveryToolDef();
    effectiveTools = [...effectiveTools, recoveryToolDef];
  }

  // Build context thunks + callbacks bag
  const callbacks: Record<string, any> = {};
  const buildCtx: BuildContext = {
    getSession: () => state.getSnapshot(),
    getStatusCallback: () => opts.statusCallback,
    callbacks,
    getUserMemoryFetcher: opts.userMemoryFetcher ? () => opts.userMemoryFetcher!(opts.userId) : undefined,
  };

  const mwChain = new MiddlewareChain(buildCtx);
  mwChain.installFromRegistry(middlewareEntries, cfg);

  // Final invoker: executes real tools, handles terminators, recovery, and
  // the memory-write security boundary. Recovery is intercepted BEFORE the
  // middleware chain in a separate path (see loop body) so middlewares don't
  // see recall calls — it's a framework-internal protocol.
  const grantedPerms = opts.permissions ?? new Set<ToolPermission>();
  // Names the user said "always allow" during this run.
  const alwaysAllow = new Set<string>();
  // Resolve cwd / allowedPaths once.
  const runCwd = opts.cwd ?? process.cwd();
  const runAllowedPaths = opts.allowedPaths ?? [runCwd];

  const finalToolInvoker = async (calls: ToolCallRequest[]): Promise<ToolCallResult[]> => {
    const results: ToolCallResult[] = [];
    for (const call of calls) {
      const toolDef = getTool(call.name)
        || effectiveTools.find(t => t.name === call.name)
        || (recoveryToolDef && call.name === recoveryToolDef.name ? recoveryToolDef : undefined);
      if (!toolDef) {
        results.push({ id: call.id, name: call.name, content: `Unknown tool ${call.name}`, error: true });
        continue;
      }

      // M3.1 — Argument validation. Schema errors become structured tool
      // results so the model can self-correct on the next round.
      let validatedArgs: Record<string, unknown> = call.arguments;
      if (toolDef.paramsSchema) {
        try {
          const parsed = toolDef.paramsSchema.parse(call.arguments);
          if (parsed && typeof parsed === 'object') validatedArgs = parsed as Record<string, unknown>;
        } catch (e: any) {
          // Surface a compact message; the model usually reads only the first line.
          const msg = e?.issues
            ? e.issues.map((i: any) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('; ')
            : (e?.message || String(e));
          results.push({
            id: call.id, name: call.name,
            content: `ArgumentError: ${msg}`, error: true,
          });
          continue;
        }
      }

      // M3.2 — Permission gate.
      if (toolDef.permission) {
        if (!grantedPerms.has(toolDef.permission)) {
          results.push({
            id: call.id, name: call.name,
            content: `PermissionDenied: tool "${toolDef.name}" requires "${toolDef.permission}" permission, which was not granted for this run.`,
            error: true,
          });
          continue;
        }
        // Interactive approver (optional).
        if (opts.toolApprover && !alwaysAllow.has(toolDef.name)) {
          let approval: { decision: ToolApprovalDecision; reason?: string };
          try {
            approval = normalizeToolApproval(await opts.toolApprover({
              toolName: toolDef.name,
              permission: toolDef.permission,
              args: validatedArgs,
              round: state.getRound(),
            }));
          } catch (e: any) {
            results.push({
              id: call.id, name: call.name,
              content: `ApprovalError: ${e?.message || e}`, error: true,
            });
            continue;
          }
          if (approval.decision === 'deny') {
            const reason = approval.reason ? ` Reason: ${approval.reason}` : '';
            results.push({
              id: call.id, name: call.name,
              content: `PermissionDenied: user declined to run "${toolDef.name}".${reason}`,
              error: true,
            });
            continue;
          }
          if (approval.decision === 'always') alwaysAllow.add(toolDef.name);
        }
      }

      try {
        // Security boundary (memory_mechanism.md §6): wire-layer override on
        // any tool flagged as a memory write. Name-agnostic.
        if (toolDef.isMemoryWrite) {
          const wr = await acrossMem.writeMemory(opts.userId, validatedArgs);
          let content: string;
          if (!wr.success) content = `err:${wr.error}`;
          else if (wr.pendingId) {
            content = `pending: write staged as ${wr.pendingId} — user must confirm via /memory accept ${wr.pendingId} before it persists. Tell the user what you'd like to remember and the pending id; do not assume it is saved.`;
          } else {
            content = 'written';
          }
          results.push({ id: call.id, name: call.name, content });
          continue;
        }

        const out = await toolDef.handler(validatedArgs, {
          sessionId: convId,
          userId: opts.userId,
          signal: opts.signal,
          cwd: runCwd,
          allowedPaths: runAllowedPaths,
        });
        const content = typeof out === 'string' ? out : (out.content || JSON.stringify(out));
        results.push({ id: call.id, name: call.name, content });

        if (toolDef.isTerminator) {
          (results[results.length - 1] as any)._wasTerminator = true;
        }
      } catch (e: any) {
        results.push({ id: call.id, name: call.name, content: `Tool error: ${e.message}`, error: true });
      }
    }
    return results;
  };

  const wrappedInvoker = mwChain.getInvoker(finalToolInvoker);

  // Prepare system prompt base
  let baseSystem = cfg.systemPromptTemplate || 'You are a helpful agent. Use tools via function calls when needed. When ready to answer, respond without tool calls or use a terminator tool if provided.';
  // Render across-conv memory vars only when a fetcher is provided.
  // memory_mechanism.md §8: "If the configuration center doesn't deliver
  // memory settings, the entire pipeline is silently disabled." We treat
  // the absence of `userMemoryFetcher` as "disabled". CLI/server only pass
  // the fetcher when cfg.memory.acrossConversation.enabled is true.
  if (opts.userMemoryFetcher) {
    const memVars = await acrossMem.getTemplateVars(opts.userId);
    baseSystem = renderTemplate(baseSystem, memVars);
  } else {
    // Still render the template so {{vars}} not present in the data
    // resolve to empty strings rather than leaving literal {{name}} tokens
    // in the prompt (which would be a worse default than disabled-but-clean).
    baseSystem = renderTemplate(baseSystem, {});
  }

  // Teach the model about the recovery tool when active.
  if (recoveryToolDef) {
    baseSystem += `\n\nNote: tool results may be folded to a prefix; if you need the original full content, call ${recoveryToolDef.name} with the displayed ref.`;
  }

  let totalToolCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const warnings: string[] = [];
  let lastPromptTokens = 0; // cached, fed into watermark trigger

  // THE LOOP
  for (let r = 0; r < cfg.maxRounds; r++) {
    if (opts.signal?.aborted) {
      warnings.push('aborted by caller');
      state.terminate(TerminationReason.ROUND_BUDGET);
      break;
    }
    state.incrementRound();
    const currentRound = state.getRound();

    // 1. Always-on fold (cheap, predictable). Off-by-default: NONE = no-op.
    const mutableHist = state.getMutableHistory();
    inConvMem.applyFold(mutableHist);

    // 2. Watermark-triggered compact based on PREVIOUS round's prompt tokens.
    //    (Cheap layer = fold; expensive layer = compact, only under pressure.)
    await inConvMem.maybeCompact(mutableHist, lastPromptTokens);

    // 3. Apply gate + directives
    const searchGate = state.getSignals().searchGate || gate.getSearchGate();
    const gateDirective = gate.getSystemPromptDirective(searchGate);
    const userTail = gate.getUserTailDirective(searchGate);

    // 4. Truncate + assemble messages
    const sysForBudget = countMessageTokens({ role: 'system', content: baseSystem + gateDirective });
    const activeStackEst = 200; // rough for current react
    const replyEst = 800;

    const { messages: truncated, hintAppended } = histProc.truncate(
      mutableHist,
      sysForBudget,
      activeStackEst,
      replyEst
    );

    const protocolMode = cfg.protocolMode ?? 'structured';
    let assembled = histProc.assembleForLLM(
      truncated,
      baseSystem + (gateDirective ? '\n' + gateDirective : ''),
      protocolMode,
    );

    // Append user tail directive AND apply hotword stripping (5th forbid layer)
    // to the last user message.
    if (assembled.length) {
      const lastUserIdx = [...assembled].reverse().findIndex(m => m.role === 'user');
      if (lastUserIdx >= 0) {
        const realIdx = assembled.length - 1 - lastUserIdx;
        const orig = assembled[realIdx].content || '';
        const stripped = gate.stripHotwords(String(orig), searchGate);
        assembled[realIdx].content = stripped + (userTail || '');
      }
    }

    if (hintAppended) {
      warnings.push('budget hint appended');
    }

    // 5. Shape tools for this round from gate
    const { modifiedTools: gatedTools, tool_choice } = gate.applyToLLMRequest(
      { model: cfg.model, messages: [], tools: [] } as any, // dummy
      effectiveTools,
      searchGate
    );

    // Build LLM req. In text-tagged mode, the LLM API doesn't speak the
    // structured tools/tool_choice fields — we expose tool defs through the
    // system prompt instead, and the assistant emits <tool_call> tags
    // inline. (history_processing.md §4)
    const llmReq: LLMRequest = {
      model: cfg.model,
      messages: assembled,
      tools: protocolMode === 'structured' && gatedTools.length ? gatedTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })) : undefined,
      tool_choice: protocolMode === 'structured' ? tool_choice : undefined,
      signal: opts.signal,
      timeoutMs: opts.llmTimeoutMs,
    };

    // In text mode: enrich the system prompt with the available tool list
    // so the model has names + schemas to call against.
    if (protocolMode === 'text' && gatedTools.length && assembled.length && assembled[0].role === 'system') {
      const lines = ['', 'Available tools:'];
      for (const t of gatedTools) {
        lines.push(`- ${t.name}: ${t.description}`);
        lines.push(`  parameters: ${JSON.stringify(t.parameters)}`);
      }
      assembled[0].content = (assembled[0].content || '') + lines.join('\n');
    }

    // 6. Call LLM (streaming or non-streaming)
    let llmResp: LLMResponse;
    try {
      if (opts.streamLLM) {
        llmResp = await consumeStream(opts.streamLLM(llmReq), opts.onStreamEvent, currentRound);
      } else if (opts.llm) {
        llmResp = await opts.llm(llmReq);
      } else {
        throw new Error('runReActAgent: must provide either `llm` or `streamLLM`');
      }
    } catch (e: any) {
      const aborted = opts.signal?.aborted || /abort/i.test(e?.message || '');
      warnings.push(`LLM error round ${currentRound}: ${e.message}`);
      state.terminate(TerminationReason.ROUND_BUDGET);
      if (aborted) {
        warnings.push('aborted by caller');
      }
      break;
    }
    if (llmResp.usage) {
      totalPromptTokens += llmResp.usage.prompt_tokens;
      totalCompletionTokens += llmResp.usage.completion_tokens;
    }

    // 7. Parse tool calls from LLM response.
    // Structured mode: read message.tool_calls.
    // Text mode: extract <tool_call> tags from the assistant content. The
    //            content is then stripped of those tags before persisting,
    //            so subsequent rounds re-encode them via assembleForLLM.
    let parsedCalls: ToolCallRequest[];
    let assistantContent = llmResp.message?.content || '';
    if (protocolMode === 'text') {
      const parsed = parseTextProtocolToolCalls(assistantContent);
      parsedCalls = parsed.calls;
      assistantContent = parsed.contentWithoutCalls;
    } else {
      parsedCalls = (llmResp.message?.tool_calls || []).map((tc: any) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = { _raw: tc.function?.arguments };
        }
        return {
          id: tc.id,
          name: tc.function?.name,
          arguments: args,
        };
      });
    }
    const hadCalls = parsedCalls.length > 0;

    // Append assistant message to suffix (with or without calls)
    const assistantMsg: any = {
      role: 'assistant',
      content: assistantContent,
      toolCalls: hadCalls ? parsedCalls : undefined,
      tokens: countMessageTokens({ role: 'assistant', content: assistantContent, toolCalls: parsedCalls }),
      isInSuffix: true,
    };
    mutableHist.suffix.push(assistantMsg);
    opts.onLifecycleEvent?.({
      type: 'assistant_message',
      timestamp: new Date().toISOString(),
      round: currentRound,
      content: assistantContent,
      ...(hadCalls ? { toolCalls: parsedCalls.map(call => ({ ...call, arguments: { ...call.arguments } })) } : {}),
    });

    // 8. If no calls (structural done), terminate
    let execResults: ToolCallResult[] = [];
    let middlewareVetoed = false;
    let executedTerminator: any = null;

    if (!hadCalls) {
      const term = checkTermination({ round: currentRound, maxRounds: cfg.maxRounds, assistantMessageHadToolCalls: false });
      if (term.terminated) {
        state.terminate(term.reason!);
        break;
      }
    } else {
      const toolStartedAt = parsedCalls.map(() => Date.now());
      const lifecycleArguments = parsedCalls.map(call => {
        const def = getTool(call.name) || effectiveTools.find(tool => tool.name === call.name);
        if (!def?.paramsSchema) return { ...call.arguments };
        try {
          const parsed = def.paramsSchema.parse(call.arguments);
          return parsed && typeof parsed === 'object'
            ? { ...(parsed as Record<string, unknown>) }
            : { ...call.arguments };
        } catch {
          return { ...call.arguments };
        }
      });
      parsedCalls.forEach((call, callIndex) => {
        opts.onLifecycleEvent?.({
          type: 'tool_started',
          timestamp: new Date().toISOString(),
          round: currentRound,
          id: call.id,
          name: call.name,
          arguments: lifecycleArguments[callIndex],
        });
      });

      // 9. Recovery interception: run BEFORE the middleware chain so the
      //    framework-internal protocol is invisible to middlewares. Calls
      //    that aren't recovery go through the chain normally.
      const recoveryName = inConvMem.getRecoveryToolName();
      const recoveryHandler = inConvMem.getRecoveryToolHandler();
      const recoveryCalls = parsedCalls.filter(c => c.name === recoveryName);
      const otherCalls = parsedCalls.filter(c => c.name !== recoveryName);

      const recoveryResults: ToolCallResult[] = [];
      for (const rc of recoveryCalls) {
        const content = await recoveryHandler(rc.arguments);
        recoveryResults.push({ id: rc.id, name: rc.name, content });
      }
      try {
        if (otherCalls.length === 0) {
          // Only recovery calls this round — no middleware/tool work to do.
          execResults = recoveryResults;
        } else {
          const maybeResults = await wrappedInvoker(otherCalls);
          if (MiddlewareChain.isCleanTermination(maybeResults)) {
            middlewareVetoed = true;
            execResults = recoveryResults; // keep recovery output if any
          } else {
            execResults = [...recoveryResults, ...(maybeResults as ToolCallResult[])];
          }
        }
      } catch (e: any) {
        warnings.push(`Tool exec error: ${e.message}`);
        execResults = otherCalls.map(c => ({ name: c.name, content: `error: ${e.message}`, error: true }));
      }

      const unmatchedResults = new Set(execResults.map((_, index) => index));
      parsedCalls.forEach((call, callIndex) => {
        let resultIndex = execResults.findIndex((result, index) =>
          unmatchedResults.has(index) && !!call.id && result.id === call.id
        );
        if (resultIndex < 0) {
          resultIndex = execResults.findIndex((result, index) =>
            unmatchedResults.has(index) && result.name === call.name
          );
        }
        const result = resultIndex >= 0 ? execResults[resultIndex] : undefined;
        if (resultIndex >= 0) unmatchedResults.delete(resultIndex);
        opts.onLifecycleEvent?.({
          type: 'tool_completed',
          timestamp: new Date().toISOString(),
          round: currentRound,
          id: call.id,
          name: call.name,
          arguments: lifecycleArguments[callIndex],
          content: result?.content ?? (middlewareVetoed ? 'middleware vetoed' : 'tool produced no result'),
          error: result ? !!result.error : true,
          durationMs: Math.max(0, Date.now() - toolStartedAt[callIndex]),
        });
      });

      // Append tool results to history (for model to see)
      for (const res of execResults) {
        const toolMsg: any = {
          role: 'tool' as const,
          content: res.content,
          toolCallId: res.id,
          tokens: countMessageTokens({ role: 'tool', content: res.content }),
          isInSuffix: true,
        };
        // Recovery results must NOT be re-folded next round, otherwise the
        // round-trip (call recall → see content → next round → folded again)
        // makes recovery useless. Mark as folded to skip future folds.
        if (res.name === inConvMem.getRecoveryToolName()) {
          toolMsg._folded = true;
        }
        mutableHist.suffix.push(toolMsg);

        // Detect terminator (works for tools registered globally as well as
        // those discovered via effectiveTools or the recovery def).
        const tdef = getTool(res.name) || effectiveTools.find(t => t.name === res.name);
        if (tdef?.isTerminator || (res as any)._wasTerminator) {
          executedTerminator = { name: res.name, result: res };
        }

        totalToolCalls++;
      }

      // 10. Check termination conditions after exec
      const termCheck = checkTermination({
        round: currentRound,
        maxRounds: cfg.maxRounds,
        assistantMessageHadToolCalls: hadCalls,
        executedTerminator,
        middlewareVetoedAll: middlewareVetoed && execResults.length === 0,
      });

      if (termCheck.terminated) {
        state.terminate(termCheck.reason!);
        break;
      }
    }

    // 11. Round end: cleanup signals (one-shots etc). Lifetime-driven.
    state.roundEndCleanup();

    // 12. Compute current prompt tokens from CACHED message tokens
    //     (history_processing.md §2: convert once, read many).
    lastPromptTokens =
      sysForBudget +
      mutableHist.prefix.reduce((s, m) => s + (m.tokens || 0), 0) +
      mutableHist.suffix.reduce((s, m) => s + (m.tokens || 0), 0);

    // update progress
    state.updateStatusSparse({ lastStatus: 'in_progress', progress: currentRound / cfg.maxRounds });
  }

  // After loop: determine final answer
  const finalTerm = state.getTermination() || { reason: TerminationReason.ROUND_BUDGET, atRound: state.getRound() };
  const snapHist = state.getHistorySnapshot();

  // Final answer heuristic: last assistant text if no tool calls in it, or last tool result if terminator, or last assistant anyway.
  let finalAnswer = '';
  const suffix = snapHist.suffix;
  for (let i = suffix.length - 1; i >= 0; i--) {
    const m = suffix[i] as any;
    if (m.role === 'assistant' && (!m.toolCalls || m.toolCalls.length === 0)) {
      finalAnswer = m.content || '';
      break;
    }
    if (m.role === 'tool') {
      // if last was from terminator perhaps use it
      finalAnswer = m.content || finalAnswer;
      break;
    }
  }
  if (!finalAnswer && suffix.length) {
    finalAnswer = (suffix[suffix.length - 1] as any).content || '[no textual answer produced]';
  }

  return {
    finalAnswer,
    history: snapHist,
    rounds: state.getRound(),
    termination: finalTerm.reason,
    toolCallsMade: totalToolCalls,
    warnings,
    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
  };
}

function normalizeToolApproval(approval: ToolApproval): {
  decision: ToolApprovalDecision;
  reason?: string;
} {
  if (typeof approval === 'string') return { decision: approval };
  const reason = approval.reason?.trim();
  return reason
    ? { decision: approval.decision, reason }
    : { decision: approval.decision };
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/**
 * Drain a streaming LLM response into a final LLMResponse.
 * Forwards every event to the optional consumer for live rendering.
 * Throws if the stream ends with `error` or never emits `done`.
 */
async function consumeStream(
  stream: AsyncIterable<LLMStreamEvent>,
  onEvent: ((e: LLMStreamEvent, ctx: { round: number }) => void) | undefined,
  round: number,
): Promise<LLMResponse> {
  let final: LLMResponse | undefined;
  let err: Error | undefined;
  for await (const ev of stream) {
    if (onEvent) {
      try { onEvent(ev, { round }); } catch { /* consumer must not break the loop */ }
    }
    if (ev.type === 'done') final = ev.response;
    else if (ev.type === 'error') err = ev.error;
  }
  if (err) throw err;
  if (!final) throw new Error('streaming LLM client ended without a `done` event');
  return final;
}

/**
 * Parse `<tool_call name="..." id="...">{"...":...}</tool_call>` blocks out
 * of an assistant content string.
 *
 * Used by the text-tagged protocol mode (history_processing.md §4). Tags
 * with malformed JSON arguments are returned with `arguments = { _raw }`
 * so the existing argument-validation pipeline can produce a structured
 * error result (matching the structured path's behaviour).
 *
 * The returned `contentWithoutCalls` is the original content with all
 * matched tags removed, so subsequent rounds can re-emit them via
 * assembleForLLMText without doubling.
 */
const TOOL_CALL_TAG_RE = /<tool_call\s+name="([^"]*)"(?:\s+id="([^"]*)")?\s*>([\s\S]*?)<\/tool_call>/g;

function parseTextProtocolToolCalls(content: string): {
  calls: ToolCallRequest[];
  contentWithoutCalls: string;
} {
  const calls: ToolCallRequest[] = [];
  let i = 0;
  for (const m of content.matchAll(TOOL_CALL_TAG_RE)) {
    const name = decodeAttr(m[1]);
    const id = m[2] ? decodeAttr(m[2]) : `call_text_${i++}`;
    const body = m[3].trim();
    let args: Record<string, unknown>;
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      args = { _raw: body };
    }
    calls.push({ id, name, arguments: args });
  }
  const contentWithoutCalls = content.replace(TOOL_CALL_TAG_RE, '').trim();
  return { calls, contentWithoutCalls };
}

function decodeAttr(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export const __testing = { parseTextProtocolToolCalls };
