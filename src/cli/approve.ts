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
  /** Shared REPL line reader. When present, no competing readline is created. */
  readLine?: () => Promise<string | undefined>;
}

interface LineSource {
  on(event: 'line', listener: (line: string) => void): this;
  once(event: 'close', listener: () => void): this;
  off(event: 'line', listener: (line: string) => void): this;
  off(event: 'close', listener: () => void): this;
}

/**
 * Single-consumer broker for one readline interface. Normal REPL input and
 * nested approval prompts take turns calling readLine(), so a submitted line
 * can never be delivered to both consumers.
 */
export class LineInputBroker {
  private queued: string[] = [];
  private waiting: Array<(line: string | undefined) => void> = [];
  private closed = false;

  constructor(private readonly source: LineSource) {
    source.on('line', this.onLine);
    source.once('close', this.onClose);
  }

  readLine(): Promise<string | undefined> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  dispose(): void {
    this.source.off('line', this.onLine);
    this.source.off('close', this.onClose);
    this.finish(true);
  }

  private onLine = (line: string): void => {
    const waiter = this.waiting.shift();
    if (waiter) waiter(line);
    else this.queued.push(line);
  };

  private onClose = (): void => this.finish(false);

  private finish(discardQueued: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (discardQueued) this.queued = [];
    for (const waiter of this.waiting.splice(0)) waiter(undefined);
  }
}

export function createTTYApprover(opts: ApproverOptions = {}): ToolApprover {
  const input = (opts.input ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean };
  const output = opts.output ?? process.stderr;
  return async ({ toolName, permission, args }) => {
    const argsPreview = previewArgs(args);
    output.write(`\n[approval] ${toolName} (${permission}) ${argsPreview}\n`);
    if (opts.readLine) {
      output.write('  allow? [y]es / [n]o / [a]lways: ');
      return approvalForAnswer(await opts.readLine());
    }
    const rl = readline.createInterface({ input: input as any, output: output as any, terminal: false });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question('  allow? [y]es / [n]o / [a]lways: ', resolve);
      });
      return approvalForAnswer(answer);
    } finally {
      rl.close();
    }
  };
}

function approvalForAnswer(answer: string | undefined): ToolApproval {
  const normalized = answer?.trim().toLowerCase() ?? '';
  if (normalized === 'a' || normalized === 'always') return 'always';
  if (normalized === 'y' || normalized === 'yes') return 'allow';
  return 'deny';
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
