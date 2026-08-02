/**
 * Simple deterministic mock LLM for examples and tests.
 * Behaves according to gate and prompt to demo structural behavior.
 */
import { LLMClient, LLMRequest, LLMResponse } from '../src/core/types.js';

export function createMockLLM(scenario: 'direct' | 'use-tool-then-terminate' | 'force-search' = 'use-tool-then-terminate'): LLMClient {
  return async (req: LLMRequest): Promise<LLMResponse> => {
    const lastMsg = req.messages[req.messages.length - 1]?.content || '';
    const hasTools = !!req.tools && req.tools.length > 0;
    const toolChoice = req.tool_choice;

    // Simulate "seeing" the gate effects
    const forbid = (req.messages.some(m => (m.content || '').includes('Do not perform any searches')) ||
                   (toolChoice === 'none'));

    const force = typeof toolChoice === 'object' && toolChoice?.function?.name?.includes('search');

    if (scenario === 'direct' || !hasTools) {
      return {
        message: {
          content: 'The capital of France is Paris. (from knowledge, no tools needed per instructions)',
          tool_calls: undefined,
        },
      };
    }

    if (forbid) {
      // Must answer without search
      return {
        message: {
          content: 'As instructed, I will not search. From my training data, the capital of France is Paris.',
          tool_calls: undefined,
        },
      };
    }

    if (force || lastMsg.includes('search now') || scenario === 'force-search') {
      // Emit a search call
      return {
        message: {
          content: 'Let me search to confirm.',
          tool_calls: [{
            id: 'call_search1',
            function: { name: 'search_web', arguments: JSON.stringify({ query: 'capital of France' }) },
          }],
        },
      };
    }

    // Default: call search then in next "turn" (but since mock stateless per call, for demo do search first round)
    const hasSeenToolResult = req.messages.some(m => m.role === 'tool' || (typeof m.content === 'string' && m.content.includes('Mock search results')));
    if (hasSeenToolResult) {
      // After tool result seen in history, use terminator to finish structurally
      return {
        message: {
          content: 'I have the info now.',
          tool_calls: [{
            id: 'call_submit1',
            function: { name: 'submit_final_answer', arguments: JSON.stringify({ answer: 'The capital of France is Paris.' }) },
          }],
        },
      };
    }

    return {
      message: {
        content: 'I need to look that up.',
        tool_calls: [{
          id: 'call_search1',
          function: { name: 'search_web', arguments: JSON.stringify({ query: 'capital of France' }) },
        }],
      },
    };
  };
}
