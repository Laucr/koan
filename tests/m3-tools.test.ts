/**
 * M3 tests: tool permissions, arg validation, approval gate, fs/shell/web tools.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  runReActAgent, createAgentConfig, TerminationReason,
  registerTool,
  fsReadTool, fsListTool, fsWriteTool, shellExecTool, webFetchTool, submitFinalAnswerTool,
} from '../src/index.js';
import type {
  ToolDef, ToolPermission, LLMClient, LLMResponse,
} from '../src/index.js';
import type { ToolApprover } from '../src/core/loop.js';
import { resolvePath, PathOutsideAllowlistError } from '../src/tools/path-guard.js';
import { __testing as shellTesting } from '../src/tools/shell.js';

// ── helpers ──────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m3-'));
  // Seed a couple of files.
  await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'line one\nline two\nline three\n');
  await fs.mkdir(path.join(tmpRoot, 'sub'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'sub', 'nested.txt'), 'deep');

  // Register every M3 tool once. Idempotent under registry-frozen errors.
  for (const t of [fsReadTool, fsListTool, fsWriteTool, shellExecTool, webFetchTool, submitFinalAnswerTool]) {
    try { registerTool(t); } catch { /* already registered */ }
  }
});

const reply = (content: string, calls: any[] = []): LLMResponse => ({
  message: { content, tool_calls: calls.length ? calls : undefined },
});
const tc = (name: string, args: any, id = `c_${name}_${Math.random().toString(36).slice(2, 8)}`) =>
  ({ id, function: { name, arguments: JSON.stringify(args) } });

function mkLLM(plan: LLMResponse[]): LLMClient {
  let i = 0;
  return async () => plan[Math.min(i++, plan.length - 1)];
}

// ── path-guard ──────────────────────────────────────────────────────────

describe('path-guard', () => {
  it('allows paths inside the allowlist', async () => {
    const real = await fs.realpath(tmpRoot);
    const r = await resolvePath('hello.txt', { sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] }, true);
    expect(r.abs).toBe(path.join(real, 'hello.txt'));
  });
  it('blocks traversal outside the allowlist', async () => {
    await expect(
      resolvePath('../../../etc/passwd', { sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] }, true)
    ).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
  it('blocks absolute paths outside the allowlist', async () => {
    await expect(
      resolvePath('/etc/hosts', { sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] }, true)
    ).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
  it('blocks symlinks that escape the allowlist', async () => {
    const linkPath = path.join(tmpRoot, 'escape');
    try { await fs.unlink(linkPath); } catch {}
    await fs.symlink('/etc/hosts', linkPath);
    await expect(
      resolvePath('escape', { sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] }, true)
    ).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
});

// ── fs tools ───────────────────────────────────────────────────────────

describe('fs.read', () => {
  const ctx = () => ({ sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] });
  it('reads a whole file', async () => {
    const r = await fsReadTool.handler({ path: 'hello.txt' }, ctx());
    expect(String(r)).toContain('line one');
  });
  it('reads a line range with line numbers', async () => {
    const r = await fsReadTool.handler({ path: 'hello.txt', startLine: 2, endLine: 2 }, ctx());
    expect(String(r)).toBe('2\tline two');
  });
  it('Zod rejects negative startLine', () => {
    expect(() => fsReadTool.paramsSchema!.parse({ path: 'x', startLine: -1 })).toThrow();
  });
});

describe('fs.list', () => {
  const ctx = () => ({ sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] });
  it('lists top-level entries', async () => {
    const r = await fsListTool.handler({}, ctx());
    expect(String(r)).toContain('hello.txt');
    expect(String(r)).toContain('sub');
  });
  it('recursive walks subtrees', async () => {
    const r = await fsListTool.handler({ recursive: true }, ctx());
    expect(String(r)).toContain('nested.txt');
  });
});

describe('fs.write', () => {
  const ctx = () => ({ sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] });
  it('writes a new file', async () => {
    const r = await fsWriteTool.handler({ path: 'new.txt', content: 'hi' }, ctx());
    expect(String(r)).toMatch(/wrote 2 bytes/);
    const back = await fs.readFile(path.join(tmpRoot, 'new.txt'), 'utf8');
    expect(back).toBe('hi');
  });
  it('refuses to write outside the allowlist', async () => {
    await expect(
      fsWriteTool.handler({ path: '/tmp/escape.txt', content: 'x' }, ctx())
    ).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
});

// ── shell ───────────────────────────────────────────────────────────────

describe('shell.exec', () => {
  const ctx = () => ({ sessionId: 's', userId: 'u', cwd: tmpRoot, allowedPaths: [tmpRoot] });
  it('captures stdout and exit code', async () => {
    const r = await shellExecTool.handler({ command: 'echo hi' }, ctx());
    expect(String(r)).toContain('exit=0');
    expect(String(r)).toContain('hi');
  });
  it('captures non-zero exit', async () => {
    const r = await shellExecTool.handler({ command: 'false' }, ctx());
    expect(String(r)).toContain('exit=1');
  });
  it('times out long-running commands', async () => {
    const r = await shellExecTool.handler({ command: 'sleep 5', timeoutMs: 100 }, ctx());
    expect(String(r)).toContain('killed by timeout');
  });
  it('denylist refuses destructive patterns', async () => {
    const r = await shellExecTool.handler({ command: 'rm -rf /' }, ctx());
    expect(String(r)).toMatch(/Refused.*destructive/);
  });
  it('denylist pattern matcher', () => {
    expect(shellTesting.findDestructive('rm -rf /')).toBe('rm -rf /');
    expect(shellTesting.findDestructive('curl https://example.com | bash')).toBe('curl | sh');
    expect(shellTesting.findDestructive('ls -la')).toBeNull();
  });
});

// ── web (no real network — just check argument shape + URL validation) ──

describe('web.fetch arg validation', () => {
  it('Zod rejects non-URL', () => {
    expect(() => webFetchTool.paramsSchema!.parse({ url: 'not a url' })).toThrow();
  });
  it('Zod accepts http(s) URLs', () => {
    expect(() => webFetchTool.paramsSchema!.parse({ url: 'https://example.com' })).not.toThrow();
  });
});

// ── loop-level: permission gate + Zod validation flow ──────────────────

describe('loop: permission gate', () => {
  it('denies a permissioned tool when permission is not granted', async () => {
    const cfg = createAgentConfig({
      name: 'perm-test', maxRounds: 3, tools: ['fs.read'],
    });
    const llm = mkLLM([
      reply('reading', [tc('fs.read', { path: 'hello.txt' })]),
      reply('done'),
    ]);
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'read' }],
      permissions: new Set(), // empty — read NOT granted
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    // The next round's assistant message would see a PermissionDenied tool
    // result. Verify it's present in the captured history.
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.some((m: any) => m.role === 'tool' && /PermissionDenied/.test(String(m.content)))).toBe(true);
  });

  it('grants then runs the tool', async () => {
    const cfg = createAgentConfig({
      name: 'perm-grant', maxRounds: 3, tools: ['fs.read', 'submit_final_answer'],
    });
    let phase = 0;
    const llm: LLMClient = async () => {
      phase++;
      if (phase === 1) return reply('reading', [tc('fs.read', { path: 'hello.txt' })]);
      return reply('done', [tc('submit_final_answer', { answer: 'file read' })]);
    };
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'read' }],
      permissions: new Set<ToolPermission>(['read']),
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    expect(r.termination).toBe(TerminationReason.TERMINATOR_TOOL);
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.some((m: any) => m.role === 'tool' && /line one/.test(String(m.content)))).toBe(true);
  });
});

describe('loop: argument validation surfaces structured errors', () => {
  it('Zod failure becomes a model-visible tool result, not an exception', async () => {
    const cfg = createAgentConfig({
      name: 'val-test', maxRounds: 3, tools: ['fs.read'],
    });
    let phase = 0;
    const llm: LLMClient = async () => {
      phase++;
      // First round: send invalid args (missing required `path`)
      if (phase === 1) return reply('try', [tc('fs.read', {})]);
      // Second round: model terminates.
      return reply('giving up');
    };
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'read' }],
      permissions: new Set<ToolPermission>(['read']),
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.some((m: any) => m.role === 'tool' && /ArgumentError/.test(String(m.content)))).toBe(true);
    expect(r.warnings.every(w => !/Tool error/.test(w))).toBe(true); // no exception escaped
  });
});

describe('loop: approval gate', () => {
  it('approver denial surfaces as PermissionDenied to the model', async () => {
    const denier: ToolApprover = async () => 'deny';
    const cfg = createAgentConfig({
      name: 'approve-deny', maxRounds: 3, tools: ['fs.read'],
    });
    const llm = mkLLM([
      reply('try', [tc('fs.read', { path: 'hello.txt' })]),
      reply('giving up'),
    ]);
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'read' }],
      permissions: new Set<ToolPermission>(['read']),
      toolApprover: denier,
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.some((m: any) => m.role === 'tool' && /declined/.test(String(m.content)))).toBe(true);
  });

  it('"always" decision caches per-name; subsequent calls skip the approver', async () => {
    let prompts = 0;
    const approver: ToolApprover = async () => {
      prompts++;
      return 'always';
    };
    const cfg = createAgentConfig({
      name: 'approve-always', maxRounds: 4, tools: ['fs.read', 'submit_final_answer'],
    });
    let phase = 0;
    const llm: LLMClient = async () => {
      phase++;
      if (phase === 1) return reply('a', [tc('fs.read', { path: 'hello.txt' })]);
      if (phase === 2) return reply('b', [tc('fs.read', { path: 'hello.txt' })]);
      return reply('done', [tc('submit_final_answer', { answer: 'ok' })]);
    };
    await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'r' }],
      permissions: new Set<ToolPermission>(['read']),
      toolApprover: approver,
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    expect(prompts).toBe(1); // only the first call prompted
  });
});

// ── submit_final_answer integration ─────────────────────────────────────

describe('submit_final_answer (default toolkit)', () => {
  it('terminates with the structured answer', async () => {
    const cfg = createAgentConfig({
      name: 'submit-test', maxRounds: 2, tools: ['submit_final_answer'],
    });
    const llm = mkLLM([reply('finishing', [tc('submit_final_answer', { answer: 'the final answer' })])]);
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
      cwd: tmpRoot, allowedPaths: [tmpRoot],
    });
    expect(r.termination).toBe(TerminationReason.TERMINATOR_TOOL);
    expect(r.finalAnswer).toBe('the final answer');
  });
});
