import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTTYApprover, LineInputBroker } from '../src/cli/approve.js';
import {
  createSelectionState,
  renderSelection,
  selectFromTTY,
  selectTerminalOptions,
  transitionSelection,
  type SelectorKey,
} from '../src/cli/select.js';
import {
  createAgentConfig,
  fsReadTool,
  registerTool,
  runReActAgent,
  type LLMClient,
  type LLMResponse,
  type ToolPermission,
} from '../src/index.js';

const choices = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
] as const;

function capture(columns?: number) {
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

describe('issue #1 selector contract', () => {
  it('blocks implicit single submission and makes the first arrow an explicit wrapping selection', () => {
    const initial = createSelectionState(choices, 'single');
    expect(initial.highlighted).toBe(0);
    expect([...initial.selected]).toEqual([]);

    const blocked = transitionSelection(initial, { name: 'return' }, choices.length, 'single');
    expect(blocked.submit).toBeUndefined();
    expect(blocked.state.highlighted).toBe(0);
    expect(blocked.state.error).toMatch(/select.*option/i);

    const moved = transitionSelection(blocked.state, { name: 'up' }, choices.length, 'single');
    expect(moved.state.highlighted).toBe(2);
    expect([...moved.state.selected]).toEqual([2]);
    expect(moved.state.error).toBeUndefined();
    expect(transitionSelection(moved.state, { name: 'return' }, choices.length, 'single').submit).toBe(true);
  });

  it('keeps multi navigation separate from selection and returns values in option order', async () => {
    const moved = transitionSelection(
      createSelectionState(choices, 'multiple', ['gamma']),
      { name: 'down' },
      choices.length,
      'multiple',
    );
    expect(moved.state.highlighted).toBe(1);
    expect([...moved.state.selected]).toEqual([2]);

    const keys: SelectorKey[] = [{ name: 'space' }, { name: 'return' }];
    const selected = await selectTerminalOptions({
      message: 'Pick',
      options: choices,
      mode: 'multiple',
      initialSelected: ['gamma'],
      output: capture().output,
      readKey: async () => keys.shift(),
    });
    expect(selected).toEqual(['alpha', 'gamma']);
  });

  it('uses distinct indicators and bounds sanitized physical lines with and without terminal columns', () => {
    for (const columns of [24, undefined]) {
      const singleCapture = capture(columns);
      const multiCapture = capture(columns);
      const single = renderSelection(
        {
          message: 'Prompt\r\nwith a very long continuation that must not escape',
          options: [{ value: 'x', label: 'A very long\noption label that must truncate' }],
          mode: 'single',
          output: singleCapture.output,
        },
        createSelectionState([{ value: 'x', label: 'unused' }], 'single', ['x']),
      );
      const multiple = renderSelection(
        { message: 'Pick', options: choices, mode: 'multiple', output: multiCapture.output },
        createSelectionState(choices, 'multiple', ['alpha']),
      );
      const width = columns ?? 80;
      expect(single.every(line => !/[\r\n]/.test(line) && line.length <= width)).toBe(true);
      if (columns !== undefined) expect(single.some(line => line.endsWith('…'))).toBe(true);
      expect(single.join('')).toMatch(/[◉○]/);
      expect(multiple.join('')).toMatch(/[☑☐]/);
      expect(single.join('')).not.toBe(multiple.join(''));
    }
  });

  it('rejects invalid selector contracts before consuming a key', async () => {
    let reads = 0;
    await expect(selectTerminalOptions({
      message: 'Pick', options: [], mode: 'single', output: capture().output,
      readKey: async () => { reads++; return { name: 'return' }; },
    })).rejects.toThrow(/at least one/i);
    expect(reads).toBe(0);
    expect(() => createSelectionState(choices, 'single', ['missing'])).toThrow(/does not match/i);
    expect(() => createSelectionState(choices, 'single', ['alpha', 'beta'])).toThrow(/at most one/i);
  });

  it('restores raw mode when rendering fails', async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw?: boolean;
      isTTY?: boolean;
      setRawMode: (mode: boolean) => void;
    };
    const modes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = mode => { input.isRaw = mode; modes.push(mode); };
    const output = {
      write() { throw new Error('write failed'); },
    } as unknown as NodeJS.WritableStream;
    await expect(selectFromTTY({ message: 'Pick', options: choices, mode: 'single', output }, input))
      .rejects.toThrow(/write failed/);
    expect(modes).toEqual([true, false]);
  });
});

describe('issue #1 approval boundary', () => {
  it('presents the three permission choices in single/no-default mode and trims a denial reason', async () => {
    let request: any;
    const approver = createTTYApprover({
      output: capture().output,
      select: async incoming => { request = incoming; return ['deny']; },
      readLine: async () => '  use a safer path  ',
    });
    await expect(approver({
      toolName: 'fs.read', permission: 'read', args: { path: 'x' }, round: 1,
    })).resolves.toEqual({ decision: 'deny', reason: 'use a safer path' });
    expect(request.mode).toBe('single');
    expect(request.initialSelected).toBeUndefined();
    expect(request.options).toEqual([
      { value: 'allow', label: 'Allow once' },
      { value: 'always', label: 'Allow always' },
      { value: 'deny', label: 'Deny' },
    ]);
  });

  it('maps allow and always literally and does not ask for a reason', async () => {
    for (const decision of ['allow', 'always'] as const) {
      let lineReads = 0;
      const approver = createTTYApprover({
        output: capture().output,
        select: async () => [decision],
        readLine: async () => { lineReads++; return 'unused'; },
      });
      await expect(approver({
        toolName: 'fs.read', permission: 'read', args: {}, round: 1,
      })).resolves.toBe(decision);
      expect(lineReads).toBe(0);
    }
  });

  it('fails closed when selection input is unavailable', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const approver = createTTYApprover({ input, output: capture().output });
    await expect(approver({
      toolName: 'fs.read', permission: 'read', args: {}, round: 1,
    })).resolves.toBe('deny');
  });

  it('leases broker key input exclusively and hands the next line back untouched', async () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    const broker = new LineInputBroker(rl, input as any);
    const selected = broker.select({
      message: 'Pick', options: choices, mode: 'single', output: capture().output,
    });
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'return' });
    rl.emit('line', '');
    await expect(selected).resolves.toEqual(['beta']);
    const next = broker.readLine();
    input.write('next user prompt\n');
    await expect(next).resolves.toBe('next user prompt');
    broker.dispose();
    rl.close();
    input.end();
  });

  it('releases broker ownership when selector output throws', async () => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    const broker = new LineInputBroker(rl, input as any);
    const brokenOutput = {
      write() { throw new Error('selector output failed'); },
    } as unknown as NodeJS.WritableStream;
    await expect(broker.select({
      message: 'Pick', options: choices, mode: 'single', output: brokenOutput,
    })).rejects.toThrow(/selector output failed/);

    const next = broker.readLine();
    input.write('line after failure\n');
    await expect(next).resolves.toBe('line after failure');
    broker.dispose();
    rl.close();
    input.end();
  });
});

describe('issue #1 core approval compatibility', () => {
  let tmpRoot: string;
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-bailiff-selector-'));
    await fs.writeFile(path.join(tmpRoot, 'safe.txt'), 'safe');
    try { registerTool(fsReadTool); } catch { /* registry may already be frozen by the suite */ }
  });

  const reply = (content: string, calls: any[] = []): LLMResponse => ({
    message: { content, tool_calls: calls.length ? calls : undefined },
  });

  it('normalizes structured denials into model-visible output while legacy strings remain accepted', async () => {
    for (const approval of ['deny', { decision: 'deny' as const, reason: '  policy says no  ' }]) {
      let turn = 0;
      const llm: LLMClient = async () => turn++ === 0
        ? reply('try', [{ id: `call_${turn}`, function: { name: 'fs.read', arguments: '{"path":"safe.txt"}' } }])
        : reply('done');
      const result = await runReActAgent({
        agentConfig: createAgentConfig({ name: 'selector-bailiff', maxRounds: 3, tools: ['fs.read'] }),
        llm,
        userId: 'u',
        initialMessages: [{ role: 'user', content: 'read' }],
        permissions: new Set<ToolPermission>(['read']),
        toolApprover: async () => approval,
        cwd: tmpRoot,
        allowedPaths: [tmpRoot],
      });
      const denied = [...result.history.prefix, ...result.history.suffix]
        .find(message => message.role === 'tool' && String(message.content).includes('PermissionDenied'));
      expect(denied).toBeDefined();
      if (typeof approval === 'string') expect(String(denied?.content)).not.toContain('Reason:');
      else expect(String(denied?.content)).toContain('Reason: policy says no');
    }
  });
});
