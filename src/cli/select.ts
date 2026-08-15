import readline from 'node:readline';

export type SelectionMode = 'single' | 'multiple';

export interface SelectorOption<T> {
  value: T;
  label: string;
}

export interface SelectorKey {
  name?: string;
  ctrl?: boolean;
}

export interface SelectionState {
  highlighted: number;
  selected: ReadonlySet<number>;
  error?: string;
}

export interface SelectionTransition {
  state: SelectionState;
  submit?: true;
  cancel?: true;
}

export interface TerminalSelectRequest<T> {
  message: string;
  options: readonly SelectorOption<T>[];
  mode: SelectionMode;
  initialSelected?: readonly T[];
  required?: boolean;
  output: NodeJS.WritableStream & { columns?: number };
}

export interface TerminalSelectOptions<T> extends TerminalSelectRequest<T> {
  readKey: () => Promise<SelectorKey | undefined>;
}

const REQUIRED_MESSAGE = 'Select at least one option';

export function createSelectionState<T>(
  options: readonly SelectorOption<T>[],
  mode: SelectionMode,
  initialSelected: readonly T[] = [],
): SelectionState {
  if (options.length === 0) throw new Error('selector requires at least one option');
  const selected = new Set<number>();
  for (const value of initialSelected) {
    const index = options.findIndex(option => Object.is(option.value, value));
    if (index < 0) throw new Error('initial selection does not match an option');
    selected.add(index);
  }
  if (mode === 'single' && selected.size > 1) {
    throw new Error('single-select accepts at most one initial selection');
  }
  return { highlighted: 0, selected };
}

export function transitionSelection(
  state: SelectionState,
  key: SelectorKey | undefined,
  optionCount: number,
  mode: SelectionMode,
  required = true,
): SelectionTransition {
  if (!key || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    return { state, cancel: true };
  }

  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    const highlighted = (state.highlighted + delta + optionCount) % optionCount;
    const selected = mode === 'single'
      ? new Set([highlighted])
      : new Set(state.selected);
    return { state: { highlighted, selected } };
  }

  if (key.name === 'space' && mode === 'multiple') {
    const selected = new Set(state.selected);
    if (selected.has(state.highlighted)) selected.delete(state.highlighted);
    else selected.add(state.highlighted);
    return { state: { highlighted: state.highlighted, selected } };
  }

  if (key.name === 'return' || key.name === 'enter') {
    if (required && state.selected.size === 0) {
      return { state: { ...state, error: REQUIRED_MESSAGE } };
    }
    return { state, submit: true };
  }

  return { state };
}

export function renderSelection<T>(
  request: TerminalSelectRequest<T>,
  state: SelectionState,
): string[] {
  const width = Math.max(20, request.output.columns ?? 80);
  const lines = [truncateLine(request.message, width)];
  request.options.forEach((option, index) => {
    const cursor = index === state.highlighted ? '›' : ' ';
    const checked = state.selected.has(index);
    const indicator = request.mode === 'single'
      ? (checked ? '◉' : '○')
      : (checked ? '☑' : '☐');
    lines.push(truncateLine(`${cursor} ${indicator} ${option.label}`, width));
  });
  lines.push(state.error ? truncateLine(`! ${state.error}`, width) : '');
  return lines;
}

export async function selectTerminalOptions<T>(
  request: TerminalSelectOptions<T>,
): Promise<T[] | undefined> {
  let state = createSelectionState(
    request.options,
    request.mode,
    request.initialSelected,
  );
  let renderedLines = 0;

  const render = () => {
    const lines = renderSelection(request, state);
    if (renderedLines > 1) request.output.write(`\x1b[${renderedLines - 1}A`);
    for (let index = 0; index < Math.max(renderedLines, lines.length); index++) {
      request.output.write('\r\x1b[2K');
      if (index < lines.length) request.output.write(lines[index]);
      if (index < Math.max(renderedLines, lines.length) - 1) request.output.write('\n');
    }
    renderedLines = lines.length;
  };

  render();
  try {
    while (true) {
      const transition = transitionSelection(
        state,
        await request.readKey(),
        request.options.length,
        request.mode,
        request.required ?? true,
      );
      state = transition.state;
      if (transition.cancel) return undefined;
      if (transition.submit) {
        return request.options
          .filter((_option, index) => state.selected.has(index))
          .map(option => option.value);
      }
      render();
    }
  } finally {
    request.output.write('\n');
  }
}

export async function selectFromTTY<T>(
  request: TerminalSelectRequest<T>,
  input: NodeJS.ReadableStream & {
    isRaw?: boolean;
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  },
): Promise<T[] | undefined> {
  if (!input.isTTY || !input.setRawMode) return undefined;
  const wasRaw = input.isRaw ?? false;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const queued: SelectorKey[] = [];
  const waiting: Array<(key: SelectorKey | undefined) => void> = [];
  const onKeypress = (_value: string, key: SelectorKey) => {
    if (key.ctrl && key.name === 'c') process.emit('SIGINT');
    const waiter = waiting.shift();
    if (waiter) waiter(key);
    else queued.push(key);
  };
  const onEnd = () => {
    for (const waiter of waiting.splice(0)) waiter(undefined);
  };
  input.on('keypress', onKeypress);
  input.once('end', onEnd);
  try {
    return await selectTerminalOptions({
      ...request,
      readKey: () => {
        const queuedKey = queued.shift();
        if (queuedKey) return Promise.resolve(queuedKey);
        return new Promise(resolve => waiting.push(resolve));
      },
    });
  } finally {
    input.off('keypress', onKeypress);
    input.off('end', onEnd);
    input.setRawMode(wasRaw);
  }
}

function truncateLine(value: string, width: number): string {
  const oneLine = value.replace(/[\r\n\t]+/g, ' ');
  if (oneLine.length <= width) return oneLine;
  if (width <= 1) return '…'.slice(0, width);
  return oneLine.slice(0, width - 1) + '…';
}
