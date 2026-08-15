import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createSelectionState,
  renderSelection,
  selectFromTTY,
  selectTerminalOptions,
  transitionSelection,
  type SelectorKey,
} from '../src/cli/select.js';

const options = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' },
  { value: 'three', label: 'Three' },
] as const;

function outputAt(columns = 80) {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  }) as Writable & { columns?: number };
  output.columns = columns;
  return { output, text: () => text };
}

describe('terminal selector state', () => {
  it('requires an arrow move before submitting a no-default single selection', () => {
    const initial = createSelectionState(options, 'single');
    const blocked = transitionSelection(initial, { name: 'return' }, options.length, 'single');
    expect(blocked.submit).toBeUndefined();
    expect(blocked.state.error).toMatch(/select at least one/i);

    const moved = transitionSelection(blocked.state, { name: 'down' }, options.length, 'single');
    expect([...moved.state.selected]).toEqual([1]);
    expect(moved.state.error).toBeUndefined();
    expect(transitionSelection(moved.state, { name: 'return' }, options.length, 'single').submit).toBe(true);
  });

  it('wraps arrows and replaces the single selection', () => {
    const initial = createSelectionState(options, 'single', ['one']);
    const up = transitionSelection(initial, { name: 'up' }, options.length, 'single');
    expect(up.state.highlighted).toBe(2);
    expect([...up.state.selected]).toEqual([2]);
    const down = transitionSelection(up.state, { name: 'down' }, options.length, 'single');
    expect(down.state.highlighted).toBe(0);
    expect([...down.state.selected]).toEqual([0]);
  });

  it('toggles multiple values with Space and returns option order', async () => {
    const { output } = outputAt();
    const keys: SelectorKey[] = [
      { name: 'space' },
      { name: 'down' },
      { name: 'down' },
      { name: 'space' },
      { name: 'return' },
    ];
    const selected = await selectTerminalOptions({
      message: 'Pick', options, mode: 'multiple', output,
      readKey: async () => keys.shift(),
    });
    expect(selected).toEqual(['one', 'three']);
  });

  it('submits a configured default without navigation', async () => {
    const { output } = outputAt();
    const selected = await selectTerminalOptions({
      message: 'Pick', options, mode: 'single', initialSelected: ['two'], output,
      readKey: async () => ({ name: 'return' }),
    });
    expect(selected).toEqual(['two']);
  });

  it('cancels on EOF or Ctrl-C', () => {
    const state = createSelectionState(options, 'single');
    expect(transitionSelection(state, undefined, options.length, 'single').cancel).toBe(true);
    expect(transitionSelection(state, { name: 'c', ctrl: true }, options.length, 'single').cancel).toBe(true);
  });

  it('rejects empty options and invalid defaults', () => {
    expect(() => createSelectionState([], 'single')).toThrow(/at least one/);
    expect(() => createSelectionState(options, 'single', ['missing'])).toThrow(/does not match/);
    expect(() => createSelectionState(options, 'single', ['one', 'two'])).toThrow(/at most one/);
  });
});

describe('terminal selector rendering', () => {
  it('uses distinct radio and checkbox indicators', () => {
    const singleOutput = outputAt();
    const multiOutput = outputAt();
    const single = renderSelection(
      { message: 'Pick', options, mode: 'single', output: singleOutput.output },
      createSelectionState(options, 'single', ['one']),
    ).join('\n');
    const multiple = renderSelection(
      { message: 'Pick', options, mode: 'multiple', output: multiOutput.output },
      createSelectionState(options, 'multiple', ['one']),
    ).join('\n');
    expect(single).toContain('◉');
    expect(single).toContain('○');
    expect(multiple).toContain('☑');
    expect(multiple).toContain('☐');
  });

  it('sanitizes and truncates every physical line to the terminal width', () => {
    const { output } = outputAt(20);
    const lines = renderSelection(
      {
        message: 'A prompt with\na newline and a long tail',
        options: [{ value: 1, label: 'An option label that is much too long' }],
        mode: 'single', output,
      },
      createSelectionState([{ value: 1, label: 'unused' }], 'single'),
    );
    expect(lines.every(line => line.length <= 20)).toBe(true);
    expect(lines.join('')).not.toContain('\n');
    expect(lines.some(line => line.endsWith('…'))).toBe(true);
  });

  it('renders required-selection feedback after invalid Enter', async () => {
    const capture = outputAt();
    const keys: SelectorKey[] = [{ name: 'return' }, { name: 'down' }, { name: 'return' }];
    await selectTerminalOptions({
      message: 'Pick', options, mode: 'single', output: capture.output,
      readKey: async () => keys.shift(),
    });
    expect(capture.text()).toContain('Select at least one option');
    expect(capture.text()).toContain('\x1b[');
  });

  it('owns and restores raw mode for a standalone TTY selection', async () => {
    const capture = outputAt();
    const input = new PassThrough() as PassThrough & {
      isRaw?: boolean;
      isTTY?: boolean;
      setRawMode: (mode: boolean) => void;
    };
    const modes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = mode => { input.isRaw = mode; modes.push(mode); };
    const selected = selectFromTTY({
      message: 'Pick', options, mode: 'single', output: capture.output,
    }, input);
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    await expect(selected).resolves.toEqual(['two']);
    expect(modes).toEqual([true, false]);
  });
});
