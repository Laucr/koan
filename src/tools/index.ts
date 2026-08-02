/**
 * Default agent toolkit (M3).
 *
 * These are the tools the CLI surfaces by default. Each declares a
 * permission; the runtime refuses to call them unless the run has been
 * granted the matching capability (via `--auto-approve safe|all` or the
 * interactive approver).
 *
 * `submit_final_answer` is the terminator tool. It has no permission and
 * always runs — it's the agent's structured-answer escape hatch.
 *
 * `write_user_memory` (M7) has no permission either — it's gated by the
 * runtime's confirmation queue + /memory slash command instead.
 */
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';
import { registerTool } from '../core/registry.js';
import { fsReadTool, fsListTool, fsWriteTool } from './fs.js';
import { shellExecTool } from './shell.js';
import { webFetchTool } from './web.js';
import { writeUserMemoryTool } from './memory.js';

const SubmitFinalAnswerSchema = z.object({
  answer: z.string().min(1),
});

export const submitFinalAnswerTool: ToolDef = {
  name: 'submit_final_answer',
  description: 'Call this when you have the complete answer for the user. Provide the polished final response as `answer`.',
  isTerminator: true,
  parameters: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
  paramsSchema: SubmitFinalAnswerSchema,
  handler: async (raw) => {
    const a = SubmitFinalAnswerSchema.parse(raw);
    return a.answer;
  },
};

export const DEFAULT_TOOLKIT: readonly ToolDef[] = [
  fsReadTool,
  fsListTool,
  fsWriteTool,
  shellExecTool,
  webFetchTool,
  writeUserMemoryTool,
  submitFinalAnswerTool,
];

/** Register the default toolkit. Safe to call once before initRegistries. */
export function registerDefaultToolkit(): void {
  for (const t of DEFAULT_TOOLKIT) {
    try { registerTool(t); } catch (e: any) {
      // Re-registration in dev is non-fatal; surface anything else.
      if (!/Duplicate tool registration|frozen/.test(String(e?.message))) throw e;
    }
  }
}

export { fsReadTool, fsListTool, fsWriteTool, shellExecTool, webFetchTool, writeUserMemoryTool };
