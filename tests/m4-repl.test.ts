/**
 * M4 tests: REPL session state, slash commands, save/load roundtrip,
 * multi-turn history merge.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { ReplSession, saveSession, loadSession, SESSION_FORMAT_VERSION } from '../src/cli/session.js';
import { repl, shouldRenderFinalAnswer } from '../src/cli/repl.js';
import { handleSlash } from '../src/cli/slash.js';
import type { ConversationHistory, ProcessedMessage } from '../src/index.js';

const mkSession = () => new ReplSession({
  initialPermissions: new Set(['read']),
  model: 'gpt-x',
  provider: 'openai',
});

const pm = (role: 'user' | 'assistant' | 'tool', content: string, extra: Partial<ProcessedMessage> = {}): ProcessedMessage =>
  ({ role, content, tokens: 1, isInSuffix: true, ...extra });

describe('REPL final-answer rendering', () => {
  it('prints non-streaming and terminator-tool answers', () => {
    expect(shouldRenderFinalAnswer('answer', '', true)).toBe(true);
    expect(shouldRenderFinalAnswer('final answer', 'Let me check.', false)).toBe(true);
  });

  it('does not duplicate an answer already rendered by streaming deltas', () => {
    expect(shouldRenderFinalAnswer('final answer', 'Working...final answer', false)).toBe(false);
  });
});

describe('REPL initial prompt', () => {
  it('renders the prompt before waiting for the first input line', async () => {
    const input = new PassThrough();
    let output = '';
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    const running = repl({
      input,
      stdout: stdout as NodeJS.WriteStream,
      stderr: stderr as NodeJS.WriteStream,
      noTools: true,
      noStream: true,
      config: {
        provider: 'openai', model: 'gpt-mock', apiKey: 'sk-test',
        llmTimeoutMs: 1000,
        sources: { provider: 'flag', model: 'flag', apiKey: 'env' },
      },
    });

    expect(output).toContain('> ');
    input.end('/exit\n');
    await running;
  });
});

// ── ReplSession ─────────────────────────────────────────────────────────

describe('ReplSession', () => {
  it('appendUserMessage grows history; getHistory returns a copy', () => {
    const s = mkSession();
    s.appendUserMessage('hello');
    s.appendUserMessage('again');
    const h = s.getHistory();
    expect(h.length).toBe(2);
    h.push({ role: 'user', content: 'evil' });
    expect(s.getHistory().length).toBe(2); // mutation didn't leak
  });

  it('getPermissions / togglePermission', () => {
    const s = mkSession();
    expect([...s.getPermissions()]).toEqual(['read']);
    expect(s.togglePermission('shell')).toBe(true); // added
    expect(s.getPermissions().has('shell')).toBe(true);
    expect(s.togglePermission('shell')).toBe(false); // removed
    expect(s.getPermissions().has('shell')).toBe(false);
  });

  it('mergeRunResult appends only the tail (loop-added messages)', () => {
    const s = mkSession();
    s.appendUserMessage('q1');
    // Simulate loop result: prefix is empty (single user turn so far),
    // suffix is [user, assistant].
    const result: ConversationHistory = {
      prefix: [],
      suffix: [pm('user', 'q1'), pm('assistant', 'a1')],
      nextMediaId: { image: 0, video: 0, document: 0 },
    };
    s.mergeRunResult(result);
    const h = s.getHistory();
    expect(h.length).toBe(2);
    expect(h[0]).toEqual({ role: 'user', content: 'q1' });
    expect(h[1]).toEqual({ role: 'assistant', content: 'a1' });
  });

  it('mergeRunResult after a second turn preserves prior raw history', () => {
    const s = mkSession();
    // turn 1
    s.appendUserMessage('q1');
    s.mergeRunResult({
      prefix: [],
      suffix: [pm('user', 'q1'), pm('assistant', 'a1')],
      nextMediaId: { image: 0, video: 0, document: 0 },
    });
    // turn 2
    s.appendUserMessage('q2');
    // The loop saw [user q1, assistant a1, user q2] and appended a2.
    s.mergeRunResult({
      prefix: [pm('user', 'q1', { isInSuffix: false }), pm('assistant', 'a1', { isInSuffix: false })],
      suffix: [pm('user', 'q2'), pm('assistant', 'a2')],
      nextMediaId: { image: 0, video: 0, document: 0 },
    });
    const h = s.getHistory();
    expect(h.map(m => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('clear wipes history but keeps permissions and model', () => {
    const s = mkSession();
    s.appendUserMessage('x');
    s.togglePermission('shell');
    s.clear();
    expect(s.getHistory()).toEqual([]);
    expect(s.getPermissions().has('shell')).toBe(true);
    expect(s.model).toBe('gpt-x');
  });

  it('describe formats history one-line-per-message', () => {
    const s = mkSession();
    s.appendUserMessage('hi');
    s.mergeRunResult({
      prefix: [],
      suffix: [pm('user', 'hi'), pm('assistant', 'hello there')],
      nextMediaId: { image: 0, video: 0, document: 0 },
    });
    const desc = s.describe();
    expect(desc).toContain('user');
    expect(desc).toContain('assistant');
    expect(desc).toContain('hi');
    expect(desc).toContain('hello there');
  });
});

// ── save/load roundtrip ─────────────────────────────────────────────────

describe('saveSession / loadSession', () => {
  it('roundtrips history, permissions, and model', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m4-'));
    const file = path.join(dir, 's1.json');
    const a = mkSession();
    a.appendUserMessage('hello');
    a.mergeRunResult({
      prefix: [],
      suffix: [pm('user', 'hello'), pm('assistant', 'world')],
      nextMediaId: { image: 0, video: 0, document: 0 },
    });
    a.togglePermission('write');

    await saveSession(a, file);

    const b = new ReplSession({
      initialPermissions: new Set(),
      model: 'wrong',
      provider: 'openai',
    });
    await loadSession(b, file);
    expect(b.getHistory().map(m => m.content)).toEqual(['hello', 'world']);
    expect(b.getPermissions().has('read')).toBe(true);
    expect(b.getPermissions().has('write')).toBe(true);
    expect(b.model).toBe('gpt-x');
  });

  it('rejects an envelope with the wrong version', () => {
    const s = mkSession();
    expect(() => s.loadEnvelope({
      version: SESSION_FORMAT_VERSION + 99,
      createdAt: 'x', updatedAt: 'x',
      permissions: [], history: [],
    })).toThrow(/version/i);
  });
});

// ── slash commands ──────────────────────────────────────────────────────

describe('handleSlash', () => {
  it('/help returns continue with HELP_TEXT', async () => {
    const s = mkSession();
    const r = await handleSlash('/help', { session: s });
    expect(r.kind).toBe('continue');
    expect(r.message).toMatch(/Slash commands/);
  });

  it('/exit returns exit', async () => {
    const s = mkSession();
    const r = await handleSlash('/exit', { session: s });
    expect(r.kind).toBe('exit');
  });

  it('/clear empties history but keeps permissions', async () => {
    const s = mkSession();
    s.appendUserMessage('x');
    s.togglePermission('shell');
    await handleSlash('/clear', { session: s });
    expect(s.getHistory()).toEqual([]);
    expect(s.getPermissions().has('shell')).toBe(true);
  });

  it('/history shows entries', async () => {
    const s = mkSession();
    s.appendUserMessage('hello');
    const r = await handleSlash('/history', { session: s });
    expect(r.message).toContain('hello');
  });

  it('/permissions add / remove', async () => {
    const s = mkSession();
    await handleSlash('/permissions add shell', { session: s });
    expect(s.getPermissions().has('shell')).toBe(true);
    await handleSlash('/permissions remove shell', { session: s });
    expect(s.getPermissions().has('shell')).toBe(false);
  });

  it('/permissions rejects unknown perms', async () => {
    const s = mkSession();
    const r = await handleSlash('/permissions add bogus', { session: s });
    expect(r.kind).toBe('error');
  });

  it('/model with no arg shows current; with arg switches', async () => {
    const s = mkSession();
    const r1 = await handleSlash('/model', { session: s });
    expect(r1.message).toContain('gpt-x');
    const r2 = await handleSlash('/model gpt-y', { session: s });
    expect(r2.message).toContain('gpt-y');
    expect(s.model).toBe('gpt-y');
  });

  it('/save then /load roundtrip via slash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m4-slash-'));
    const file = path.join(dir, 's.json');
    const a = mkSession();
    a.appendUserMessage('persist me');
    const saved = await handleSlash(`/save ${file}`, { session: a });
    expect(saved.kind).toBe('continue');

    const b = mkSession();
    const loaded = await handleSlash(`/load ${file}`, { session: b });
    expect(loaded.kind).toBe('continue');
    expect(b.getHistory()[0]).toEqual({ role: 'user', content: 'persist me' });
  });

  it('unknown command returns error', async () => {
    const s = mkSession();
    const r = await handleSlash('/no-such-thing', { session: s });
    expect(r.kind).toBe('error');
  });
});
