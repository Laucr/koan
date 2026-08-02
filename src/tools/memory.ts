/**
 * write_user_memory — the cross-conversation memory write tool.
 *
 * The actual write happens at the wire-layer interception in loop.ts
 * (`isMemoryWrite: true`). This handler is only reached if interception
 * is bypassed (it shouldn't be); the handler reports that as an error so
 * the user can debug.
 *
 * Permission: none — memory writes are gated by the runtime's confirmation
 * queue + slash command, not by the coarse permission system.
 */
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';

const WriteUserMemorySchema = z.object({
  key: z.string().min(1).max(128).regex(/^[\w.-]+$/, 'key must be alphanumeric (with _, ., -)'),
  value: z.string().min(1).max(4000),
});

export const writeUserMemoryTool: ToolDef = {
  name: 'write_user_memory',
  description:
    'Stage a fact about the current user to be remembered across future sessions. ' +
    'The write is NOT applied immediately — it enters a pending queue and the user ' +
    'must confirm via `/memory accept <id>` before it persists. Tell the user the key ' +
    'and value you proposed and the pending id you received back; do not assume it ' +
    'has been saved.',
  isMemoryWrite: true,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A short slug identifying the memory (e.g. "preferred_style").' },
      value: { type: 'string', description: 'The fact to remember. Keep it concise.' },
    },
    required: ['key', 'value'],
  },
  paramsSchema: WriteUserMemorySchema,
  // This handler is a safety net; the runtime intercepts before it runs.
  handler: async () => 'Memory write intercepted by runtime.',
};
