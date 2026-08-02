/**
 * Sample tools demonstrating terminator, search (gated), write memory (security), normal tool.
 */
import { ToolDef, ToolContext } from './types.js';
import { registerTool } from './registry.js';

export const searchWebTool: ToolDef = {
  name: 'search_web',
  description: 'Search the web for current information. Use when you need up-to-date facts.',
  toolClass: 'search',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    // Mock implementation
    return `Mock search results for "${args.query}": The capital of France is Paris. (simulated 2026)`;
  },
};

export const submitAnswerTool: ToolDef = {
  name: 'submit_final_answer',
  description: 'Call this when you have the complete answer for the user. Provide the polished final response.',
  isTerminator: true,
  parameters: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
    },
    required: ['answer'],
  },
  handler: async (args) => {
    // The result will be surfaced as the final answer by the loop
    return String(args.answer || 'No answer provided.');
  },
};

export const writeUserMemoryTool: ToolDef = {
  name: 'write_user_memory',
  description: 'Store a fact about the current user for future reference. The system will force the correct owner.',
  isMemoryWrite: true, // wire-layer override — owner is forced by runtime (memory_mechanism.md §6)
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['key', 'value'],
  },
  handler: async (args, ctx) => {
    // Real write is intercepted in loop for security boundary
    return `Memory write requested for key=${args.key} (owner forced by runtime)`;
  },
};

export const calculatorTool: ToolDef = {
  name: 'calculator',
  description: 'Perform simple arithmetic. Input a math expression.',
  parameters: {
    type: 'object',
    properties: { expr: { type: 'string' } },
    required: ['expr'],
  },
  handler: async (args) => {
    // naive eval for demo; real impl safer
    try {
      // eslint-disable-next-line no-eval
      const val = eval(String(args.expr).replace(/[^0-9+\-*/(). ]/g, ''));
      return `Result: ${val}`;
    } catch {
      return 'Invalid expression';
    }
  },
};

export function registerSampleTools() {
  registerTool(searchWebTool);
  registerTool(submitAnswerTool);
  registerTool(writeUserMemoryTool);
  registerTool(calculatorTool);
}
