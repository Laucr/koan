/**
 * Interactive approval prompt for tool calls.
 *
 * When stdin is a TTY and `--auto-approve none` (the default), each tool
 * call triggers a y/n/a (allow / deny / always) prompt. In non-TTY mode
 * the prompt is unavailable; the caller is expected to pass a different
 * approver (or use `--auto-approve safe|all`).
 */
import readline from 'node:readline';
import type { ToolApprover, ToolApproval } from '../core/loop.js';

export interface ApproverOptions {
  /** stdin / stdout / stderr for the prompt. Defaults to process streams. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function createTTYApprover(opts: ApproverOptions = {}): ToolApprover {
  const input = (opts.input ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean };
  const output = opts.output ?? process.stderr;
  return async ({ toolName, permission, args }) => {
    const argsPreview = previewArgs(args);
    output.write(`\n[approval] ${toolName} (${permission}) ${argsPreview}\n`);
    const rl = readline.createInterface({ input: input as any, output: output as any, terminal: false });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question('  allow? [y]es / [n]o / [a]lways: ', (a) => resolve(a.trim().toLowerCase()));
      });
      if (answer === 'a' || answer === 'always') return 'always';
      if (answer === 'y' || answer === 'yes') return 'allow';
      return 'deny';
    } finally {
      rl.close();
    }
  };
}

function previewArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '<unprintable args>';
  }
}

export function autoApprover(decision: ToolApproval): ToolApprover {
  return async () => decision;
}
