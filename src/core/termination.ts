/**
 * Loop Termination — structural, not semantic (loop_termination.md)
 * 4 conditions OR'd. Model "done" = absence of tool calls.
 * Middleware can terminate silently by returning no calls.
 * Terminator tool: runs then exit with result appended.
 * Round cap is safety brake, not plan. No "final pass" on exhaust.
 */
import { TerminationReason, ToolCallRequest, ToolCallResult } from './types.js';

export interface TerminationCheckInput {
  round: number;
  maxRounds: number;
  assistantMessageHadToolCalls: boolean; // after middleware?
  // if a terminator was among the (post-mw) calls that were executed
  executedTerminator?: { name: string; result: ToolCallResult };
  middlewareVetoedAll?: boolean;
}

export function checkTermination(input: TerminationCheckInput): { terminated: boolean; reason?: TerminationReason } {
  if (input.executedTerminator) {
    return { terminated: true, reason: TerminationReason.TERMINATOR_TOOL };
  }
  if (input.middlewareVetoedAll) {
    return { terminated: true, reason: TerminationReason.MIDDLEWARE_VETO };
  }
  if (!input.assistantMessageHadToolCalls) {
    return { terminated: true, reason: TerminationReason.NO_TOOL_CALLS };
  }
  if (input.round >= input.maxRounds) {
    return { terminated: true, reason: TerminationReason.ROUND_BUDGET };
  }
  return { terminated: false };
}

/**
 * Helper: after LLM response, extract if it had tool calls (before any mw)
 */
export function llmResponseHasToolCalls(resp: { message?: { tool_calls?: any[] } }): boolean {
  return !!(resp.message?.tool_calls && resp.message.tool_calls.length > 0);
}
