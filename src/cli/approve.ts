/**
 * Interactive approval prompt for tool calls.
 *
 * When stdin is a TTY and `--auto-approve none` (the default), each tool
 * call triggers an interactive selector. In non-TTY mode
 * the prompt is unavailable; the caller is expected to pass a different
 * approver (or use `--auto-approve safe|all`).
 */
import readline from 'node:readline';
import type { ToolApprover, ToolApprovalDecision } from '../core/loop.js';
import {
  selectFromTTY,
  selectTerminalOptions,
  type SelectorKey,
  type TerminalSelectRequest,
} from './select.js';

export interface ApproverOptions {
  /** stdin / stdout / stderr for the prompt. Defaults to process streams. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Shared REPL line reader. When present, no competing readline is created. */
  readLine?: () => Promise<string | undefined>;
  /** Shared REPL selector. When present, it owns key input for the prompt. */
  select?: <T>(request: TerminalSelectRequest<T>) => Promise<T[] | undefined>;
}

interface LineSource {
  on(event: 'line', listener: (line: string) => void): this;
  once(event: 'close', listener: () => void): this;
  off(event: 'line', listener: (line: string) => void): this;
  off(event: 'close', listener: () => void): this;
  emit(event: 'SIGINT'): boolean;
}

type KeySource = NodeJS.ReadableStream;
type KeyListener = Parameters<KeySource['on']>[1];

/**
 * Single-consumer broker for one readline interface. Normal REPL input and
 * nested approval prompts take turns calling readLine(), so a submitted line
 * can never be delivered to both consumers.
 */
export class LineInputBroker {
  private queued: string[] = [];
  private waiting: Array<(line: string | undefined) => void> = [];
  private queuedKeys: SelectorKey[] = [];
  private keyWaiting: Array<(key: SelectorKey | undefined) => void> = [];
  private keyMode = false;
  private closed = false;

  constructor(
    private readonly source: LineSource,
    private readonly keySource?: KeySource,
  ) {
    source.on('line', this.onLine);
    source.once('close', this.onClose);
    if (keySource) {
      readline.emitKeypressEvents(keySource);
      keySource.on('keypress', this.onKeypress);
    }
  }

  readLine(): Promise<string | undefined> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  async select<T>(request: TerminalSelectRequest<T>): Promise<T[] | undefined> {
    if (!this.keySource) throw new Error('interactive key input is unavailable');
    if (this.keyMode) throw new Error('an interactive selector is already active');
    if (this.waiting.length > 0) throw new Error('line input is already waiting');
    const suspended = this.keySource.listeners('keypress')
      .filter(listener => listener !== this.onKeypress) as KeyListener[];
    for (const listener of suspended) this.keySource.removeListener('keypress', listener);
    this.keyMode = true;
    try {
      return await selectTerminalOptions({
        ...request,
        readKey: () => {
          const queuedKey = this.queuedKeys.shift();
          if (queuedKey) return Promise.resolve(queuedKey);
          if (this.closed) return Promise.resolve(undefined);
          return new Promise(resolve => this.keyWaiting.push(resolve));
        },
      });
    } finally {
      this.keyMode = false;
      this.queuedKeys = [];
      for (const waiter of this.keyWaiting.splice(0)) waiter(undefined);
      for (const listener of suspended) this.keySource.on('keypress', listener);
    }
  }

  dispose(): void {
    this.source.off('line', this.onLine);
    this.source.off('close', this.onClose);
    this.keySource?.off('keypress', this.onKeypress);
    this.finish(true);
  }

  private onLine = (line: string): void => {
    if (this.keyMode) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter(line);
    else this.queued.push(line);
  };

  private onKeypress = (_value: string, key: SelectorKey): void => {
    if (!this.keyMode) return;
    if (key.ctrl && key.name === 'c') this.source.emit('SIGINT');
    const waiter = this.keyWaiting.shift();
    if (waiter) waiter(key);
    else this.queuedKeys.push(key);
  };

  private onClose = (): void => this.finish(false);

  private finish(discardQueued: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (discardQueued) this.queued = [];
    this.queuedKeys = [];
    for (const waiter of this.waiting.splice(0)) waiter(undefined);
    for (const waiter of this.keyWaiting.splice(0)) waiter(undefined);
  }
}

export function createTTYApprover(opts: ApproverOptions = {}): ToolApprover {
  const input = (opts.input ?? process.stdin) as NodeJS.ReadableStream & {
    isRaw?: boolean;
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const output = (opts.output ?? process.stderr) as NodeJS.WritableStream & { columns?: number };
  return async ({ toolName, permission, args }) => {
    const argsPreview = previewArgs(args);
    output.write(`\n[approval] ${toolName} (${permission}) ${argsPreview}\n`);
    const request: TerminalSelectRequest<ToolApprovalDecision> = {
      message: 'Choose permission (\u2191/\u2193 to select, Enter to confirm)',
      options: [
        { value: 'allow', label: 'Allow once' },
        { value: 'always', label: 'Allow always' },
        { value: 'deny', label: 'Deny' },
      ],
      mode: 'single',
      output,
    };
    const selected = opts.select
      ? await opts.select(request)
      : await selectFromTTY(request, input);
    const decision = selected?.[0] ?? 'deny';
    if (decision !== 'deny' || !selected) return decision;

    output.write('Optional denial reason (Enter to skip): ');
    const reason = (await readReason(opts, input, output))?.trim();
    if (reason) {
      return { decision: 'deny', reason };
    }
    return 'deny';
  };
}

async function readReason(
  opts: ApproverOptions,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  if (opts.readLine) return opts.readLine();
  const rl = readline.createInterface({ input: input as any, output: output as any, terminal: false });
  try {
    return await new Promise<string>(resolve => rl.question('', resolve));
  } finally {
    rl.close();
  }
}

function previewArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '<unprintable args>';
  }
}

export function autoApprover(decision: ToolApprovalDecision): ToolApprover {
  return async () => decision;
}
