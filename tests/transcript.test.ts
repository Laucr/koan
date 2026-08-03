import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JsonlTranscriptWriter, defaultTranscriptRoot, newTranscriptEvent,
  redactTranscriptValue, transcriptPathFor,
} from '../src/transcript/index.js';
import { resolveTranscriptConfig } from '../src/cli/config.js';
import { MemorySessionStore } from '../src/persistence/memory-store.js';
import { runTurn } from '../src/persistence/runner.js';
import { createAgentConfig } from '../src/config/agent-loader.js';
import { SqliteSessionStore, defaultSessionsDbPath } from '../src/persistence/sqlite-store.js';
import { sessionsSubcommand } from '../src/cli/sessions-subcommand.js';
import { openSessionTranscript } from '../src/transcript/session.js';
import { registerTool } from '../src/core/registry.js';
import { runReActAgent } from '../src/core/loop.js';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'koan-transcript-'));
  temporary.push(dir);
  return dir;
}

describe('transcript paths and config', () => {
  it('uses the XDG data convention and UTC date hierarchy', () => {
    expect(defaultTranscriptRoot({ XDG_DATA_HOME: '/data' }, '/home/me')).toBe('/data/koan/transcripts');
    expect(transcriptPathFor('s_safe', '2026-08-02T23:00:00+08:00', '/root')).toBe('/root/2026/08/02/s_safe.jsonl');
    expect(() => transcriptPathFor('../escape', new Date().toISOString(), '/root')).toThrow(/Unsafe session id/);
  });

  it('resolves transcript file, env, and flag precedence', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'config.json');
    await fs.promises.writeFile(file, JSON.stringify({ transcripts: { enabled: false, directory: '/file' } }));
    expect(resolveTranscriptConfig({ filePath: file, env: {} })).toEqual({ enabled: false, directory: '/file' });
    expect(resolveTranscriptConfig({ filePath: file, env: { KOAN_TRANSCRIPTS_ENABLED: 'yes', KOAN_TRANSCRIPTS_DIR: '/env' } })).toEqual({ enabled: true, directory: '/env' });
    expect(resolveTranscriptConfig({ filePath: file, env: {}, flags: { transcriptEnabled: true, transcriptDirectory: '/flag' } })).toEqual({ enabled: true, directory: '/flag' });
    expect(() => resolveTranscriptConfig({ filePath: path.join(dir, 'missing'), env: { KOAN_TRANSCRIPTS_ENABLED: 'maybe' } })).toThrow(/must be one of/);
  });
});

describe('canonical JSONL writer', () => {
  it('appends complete redacted records and resumes its sequence', async () => {
    const dir = await tempDir();
    const file = path.join(dir, '2026', '08', '02', 's_test.jsonl');
    let writer = await JsonlTranscriptWriter.open({ path: file, sessionId: 's_test' });
    await writer.append([
      newTranscriptEvent('session.started', { apiKey: 'secret', nested: { authorization: 'Bearer abc' } }),
      newTranscriptEvent('turn.started', {}, { turnId: 't_1' }),
    ]);
    await writer.close();
    writer = await JsonlTranscriptWriter.open({ path: file, sessionId: 's_test' });
    await writer.append([newTranscriptEvent('session.closed', {})]);
    await writer.close();

    const lines = (await fs.promises.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines.map(line => line.sequence)).toEqual([1, 2, 3]);
    expect(lines[0].payload).toEqual({ apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
    if (process.platform !== 'win32') expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('repairs an incomplete final record without rewriting valid lines', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 's_test.jsonl');
    const writer = await JsonlTranscriptWriter.open({ path: file, sessionId: 's_test' });
    await writer.append([newTranscriptEvent('turn.started', {})]);
    await writer.close();
    await fs.promises.appendFile(file, '{"schema_version":1');
    const resumed = await JsonlTranscriptWriter.open({ path: file, sessionId: 's_test' });
    await resumed.append([newTranscriptEvent('session.closed', {})]);
    await resumed.close();
    const lines = (await fs.promises.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map(JSON.parse).map(line => line.sequence)).toEqual([1, 2]);
  });

  it('redacts recursively without mutating input', () => {
    const input = { headers: { Authorization: 'Bearer token' }, value: 'ok' };
    expect(redactTranscriptValue(input)).toEqual({ headers: { Authorization: '[REDACTED]' }, value: 'ok' });
    expect(input.headers.Authorization).toBe('Bearer token');
  });
});

describe('runner transcript integration', () => {
  it('flushes a complete turn after the store is updated', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 's_runner.jsonl');
    const writer = await JsonlTranscriptWriter.open({ path: file, sessionId: 's_runner' });
    const store = new MemorySessionStore();
    await store.create({
      id: 's_runner', profile: 'test', provider: 'openai', model: 'mock', cwd: dir,
      permissions: [], usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 }, messages: [],
    });
    const result = await runTurn({
      store, sessionId: 's_runner', history: [{ role: 'user', content: 'hello' }],
      agentConfig: createAgentConfig({ name: 'test', model: 'mock', maxRounds: 1, tools: [], middlewares: [] }),
      llm: async () => ({ message: { content: 'world' }, usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      userId: 'u', permissions: new Set(), cwd: dir, allowedPaths: [dir], transcript: writer,
    });
    await writer.close();
    const events = (await fs.promises.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(events.map(event => event.type)).toEqual(['turn.started', 'message.user', 'message.assistant', 'turn.completed']);
    expect(result.finalAnswer).toBe('world');
    expect((await store.get('s_runner'))?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  it('emits correlated assistant and tool lifecycle events', async () => {
    registerTool({
      name: 'transcript.echo', description: 'echo', parameters: { type: 'object' },
      handler: async args => String(args.value),
    });
    let call = 0;
    const lifecycle: any[] = [];
    await runReActAgent({
      agentConfig: createAgentConfig({ name: 'events', model: 'mock', maxRounds: 2, tools: ['transcript.echo'], middlewares: [] }),
      llm: async () => call++ === 0
        ? { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'transcript.echo', arguments: '{"value":"ok"}' } }] } }
        : { message: { content: 'done' } },
      initialMessages: [{ role: 'user', content: 'echo' }],
      userId: 'u', permissions: new Set(), cwd: process.cwd(), allowedPaths: [process.cwd()],
      onLifecycleEvent: event => lifecycle.push(event),
    });
    expect(lifecycle.map(event => event.type)).toEqual([
      'assistant_message', 'tool_started', 'tool_completed', 'assistant_message',
    ]);
    expect(lifecycle[1]).toMatchObject({ id: 'c1', name: 'transcript.echo', arguments: { value: 'ok' } });
    expect(lifecycle[2]).toMatchObject({ id: 'c1', content: 'ok', error: false });
  });
});

describe('sessions transcript commands', () => {
  it('discovers, exports, and deletes the transcript with its session', async () => {
    const dir = await tempDir();
    const oldData = process.env.XDG_DATA_HOME;
    const oldConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
    try {
      const store = new SqliteSessionStore({ filePath: defaultSessionsDbPath() });
      const record = await store.create({
        id: 's_cli', profile: 'test', provider: 'openai', model: 'mock', cwd: dir,
        permissions: [], usage: { promptTokens: 1, completionTokens: 1, toolCalls: 0, rounds: 1 },
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      });
      store.close();
      const writer = await openSessionTranscript(record, defaultTranscriptRoot());
      await writer.close();

      let stdout = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { stdout += String(chunk); return true; }) as any);
      vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);

      expect(await sessionsSubcommand(['where', '--transcripts'])).toBe(0);
      expect(stdout.trim()).toBe(defaultTranscriptRoot());
      stdout = '';
      expect(await sessionsSubcommand(['export', 's_cli', '--format', 'codex'])).toBe(0);
      expect(stdout.trim().split('\n').map(JSON.parse)[0]).toEqual({ type: 'thread.started', thread_id: 's_cli' });
      stdout = '';
      expect(await sessionsSubcommand(['delete', 's_cli'])).toBe(0);
      expect(stdout).toContain('deleted session: s_cli');
      expect(fs.existsSync(writer.path)).toBe(false);
      const verify = new SqliteSessionStore({ filePath: defaultSessionsDbPath() });
      expect(await verify.get('s_cli')).toBeUndefined();
      verify.close();
    } finally {
      if (oldData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldData;
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
    }
  });
});
