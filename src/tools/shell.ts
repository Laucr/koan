/**
 * shell.exec — run a shell command with a timeout, captured streams, and
 * a denylist of obviously destructive patterns.
 *
 * The denylist is a coarse guard: the user has already opted in to the
 * `shell` permission for this run, and may also have a per-call approver.
 * The denylist refuses calls that the framework would never want to
 * silently approve (e.g. `rm -rf /`) regardless of grants.
 */
import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ToolDef } from '../core/types.js';

const MAX_CAPTURE = 100_000; // 100 KB per stream

// Conservative patterns. Each is matched case-insensitively against the
// raw command string. The list is small on purpose: getting this wrong
// is worse than letting a couple of edge cases through, and there's a
// per-call approver downstream.
const DESTRUCTIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'rm -rf /',          re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i },
  { name: 'rm -rf ~',          re: /\brm\s+-[a-z]*r[a-z]*f?\s+~(?:\s|$)/i },
  { name: 'rm -rf $HOME',      re: /\brm\s+-[a-z]*r[a-z]*f?\s+\$\{?HOME\}?/i },
  { name: 'fork bomb',         re: /:\(\)\s*\{\s*:\|:.*\}\s*;\s*:/ },
  { name: 'mkfs',              re: /\bmkfs(\.\w+)?\b/i },
  { name: 'dd of=/dev/sd',     re: /\bdd\b.*\bof=\/dev\/(sd|nvme|disk|hd)/i },
  { name: 'shutdown / reboot', re: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { name: 'chmod -R 777 /',    re: /\bchmod\b.*-[a-z]*R[a-z]*\b.*\s+\/(?:\s|$)/i },
  { name: 'curl | sh',         re: /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b/i },
];

function findDestructive(cmd: string): string | null {
  for (const p of DESTRUCTIVE_PATTERNS) if (p.re.test(cmd)) return p.name;
  return null;
}

const ShellExecSchema = z.object({
  command: z.string().min(1),
  /** Working directory (must be inside the run's allowlist). Defaults to ctx.cwd. */
  cwd: z.string().optional(),
  /** Per-call timeout in ms. Defaults to 30s, cap 120s. */
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
});

export const shellExecTool: ToolDef = {
  name: 'shell.exec',
  description: 'Run a shell command and capture stdout/stderr/exit code. Times out at 30s by default (max 120s). Output is capped at 100KB per stream. The framework refuses obvious destructive patterns (rm -rf /, dd of=/dev/sd*, etc.).',
  permission: 'shell',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command. Quoting/redirection allowed.' },
      cwd: { type: 'string', description: 'Working directory; defaults to the run\'s cwd' },
      timeoutMs: { type: 'number', description: 'Per-call timeout in ms; max 120000' },
    },
    required: ['command'],
  },
  paramsSchema: ShellExecSchema,
  handler: async (raw, ctx) => {
    // Apply the schema's defaults defensively. The loop's invoker runs the
    // schema before calling this, but direct callers (tests, library users)
    // may pass raw args.
    const args = ShellExecSchema.parse(raw);
    const dest = findDestructive(args.command);
    if (dest) {
      return `Refused: command matches destructive pattern "${dest}". The shell tool will not run this even with shell permission granted.`;
    }

    // If a cwd was supplied, enforce the allowlist too.
    let cwd = ctx.cwd ?? process.cwd();
    if (args.cwd) {
      const { resolvePath } = await import('./path-guard.js');
      const r = await resolvePath(args.cwd, ctx, /*requireExists*/ true);
      cwd = r.abs;
    }

    return runCommand(args.command, cwd, args.timeoutMs, ctx.signal);
  },
};

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killed = false;

    const cap = (chunk: Buffer, sink: 'out' | 'err') => {
      const s = chunk.toString('utf8');
      if (sink === 'out') {
        if (stdout.length + s.length > MAX_CAPTURE) {
          stdout += s.slice(0, MAX_CAPTURE - stdout.length);
          truncated = true;
        } else stdout += s;
      } else {
        if (stderr.length + s.length > MAX_CAPTURE) {
          stderr += s.slice(0, MAX_CAPTURE - stderr.length);
          truncated = true;
        } else stderr += s;
      }
    };
    child.stdout.on('data', d => cap(d, 'out'));
    child.stderr.on('data', d => cap(d, 'err'));

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const lines: string[] = [
        `exit=${code ?? 'null'}${sig ? ` signal=${sig}` : ''}`,
        killed ? `(killed${signal?.aborted ? ' by caller abort' : ' by timeout'})` : '',
        truncated ? '(output truncated)' : '',
        '--- stdout ---',
        stdout,
        '--- stderr ---',
        stderr,
      ].filter(Boolean);
      resolve(lines.join('\n'));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`exec error: ${e.message}`);
    });
  });
}

export const __testing = { findDestructive };
