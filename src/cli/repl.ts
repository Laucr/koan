/**
 * Interactive REPL — multi-turn conversation with streaming, slash commands,
 * permission prompts, and a sane Ctrl-C model.
 *
 * Lifecycle per turn:
 *   1. Print the prompt; read a line (or a """-delimited block).
 *   2. If it's a slash command, dispatch and loop.
 *   3. Otherwise append a user message to the session, build a per-turn
 *      AbortController, run `runReActAgent` with streaming, merge result.
 *   4. Ctrl-C during a run aborts the run, keeps the REPL alive.
 *      Two Ctrl-Cs in a row at an idle prompt exit cleanly.
 *
 * The REPL deliberately does not own model/provider config — those are
 * decided once at startup from the resolved CLI flags. /model swaps the
 * model string for subsequent turns; the LLM client itself is rebuilt
 * lazily when needed.
 */
import readline from 'node:readline';
import { runReActAgent } from '../core/loop.js';
import { createAgentConfig } from '../config/agent-loader.js';
import { registerDefaultToolkit, DEFAULT_TOOLKIT } from '../tools/index.js';
import { initRegistries } from '../core/registry.js';
import type { LLMStreamEvent } from '../core/streaming.js';
import type { ToolPermission, AgentConfig, ToolGateMode, RawMessage } from '../core/types.js';
import type { ToolApprover } from '../core/loop.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { buildLLMClient, buildStreamingLLMClient } from './provider.js';
import { createTTYApprover, autoApprover } from './approve.js';
import { ReplSession } from './session.js';
import { handleSlash } from './slash.js';
import type { SessionStore } from '../persistence/session-store.js';
import { runTurn as runStoredTurn } from '../persistence/runner.js';
import type { UserMemoryStore } from '../persistence/user-memory-store.js';
import { memoryFetcherFor } from '../persistence/memory-fetcher.js';
import type { PendingWriteQueue } from '../core/memory.js';

export interface ReplOptions {
  /** Override the resolved config (used by tests). */
  config?: ResolvedConfig;
  /** Initial permission grants. Defaults to read-only. */
  initialPermissions?: Set<ToolPermission>;
  /** Stream injection points for testing. Default to process streams. */
  input?: NodeJS.ReadableStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Approver. Defaults to TTY-aware approver in --auto-approve none mode. */
  approver?: ToolApprover;
  /** Cwd / allowedPaths plumbed to fs.* tools. */
  cwd?: string;
  allowedPaths?: string[];
  /** Max ReAct rounds per turn. */
  maxRounds?: number;
  /** Disable the default toolkit (knowledge-only). */
  noTools?: boolean;
  /** Use ordinary chat completions instead of upstream streaming. */
  noStream?: boolean;
  /** Override the system prompt (M5: comes from the selected profile). */
  systemPromptOverride?: string;
  /** Restrict the tools surfaced to the model (M5: from profile.tools). */
  toolNamesOverride?: string[];
  /** Profile name to show in the banner. */
  profileName?: string;
  /** Initial search-gate mode (from profile.defaultSearchGate). */
  initialSearchGate?: ToolGateMode;
  /** Optional store + sessionId for persistence (M6). When omitted, the REPL
   *  runs ephemerally — useful for tests and `--no-persist`. */
  store?: SessionStore;
  sessionId?: string;
  /** Initial history to rehydrate (used when --continue or --resume). */
  initialHistory?: RawMessage[];
  /** Cross-conversation memory store (M7). When omitted, /memory commands
   *  report nothing and write_user_memory only stages to the pending queue. */
  memoryStore?: UserMemoryStore;
  /** Pending-write queue for write_user_memory. Always created if memoryStore
   *  is set; tests can inject their own. */
  pendingMemoryWrites?: PendingWriteQueue;
}

export async function repl(opts: ReplOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const input = (opts.input ?? process.stdin) as NodeJS.ReadableStream;

  const resolved = opts.config ?? resolveConfig({});
  const session = new ReplSession({
    initialPermissions: opts.initialPermissions ?? new Set(['read']),
    model: resolved.model,
    provider: resolved.provider,
  });

  // Rehydrate from a prior session if one was provided (M6 --continue / --resume).
  if (opts.initialHistory && opts.initialHistory.length > 0) {
    for (const m of opts.initialHistory) {
      // We can't call appendUserMessage for non-user roles; reach into the
      // session via loadEnvelope-style replay.
      // The simplest, safest path: snapshot a tiny envelope and load it.
      // (Permissions and model are already set above.)
    }
    // Replay by serialising via an envelope.
    const env = session.toEnvelope();
    env.history = opts.initialHistory.map(m => ({ ...m }));
    session.loadEnvelope(env);
  }

  if (!opts.noTools) {
    registerDefaultToolkit();
  }
  // Freeze process state. Idempotent — safe when chatSubcommand already
  // froze in main.ts before calling us.
  initRegistries();

  const cwd = opts.cwd ?? process.cwd();
  const allowedPaths = opts.allowedPaths ?? [cwd];

  // Build streaming client once; respects the current resolved config. When
  // /model fires we still use the same client — only the agent config's
  // `model` field changes per-turn.
  const llm = opts.noStream ? buildLLMClient(resolved) : undefined;
  const streamLLM = opts.noStream ? undefined : buildStreamingLLMClient(resolved);

  const approver: ToolApprover = opts.approver ?? createTTYApprover({ output: stderr });

  // ── readline plumbing ────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: input as any,
    output: stdout,
    terminal: true,
    prompt: '> ',
  });

  // Turn-scoped abort controller. Replaced before each run; SIGINT pops it.
  let turnAbort: AbortController | null = null;
  let pendingExit = false;

  const onSigint = () => {
    if (turnAbort && !turnAbort.signal.aborted) {
      stderr.write('\n[interrupted; aborting turn]\n');
      turnAbort.abort(new Error('SIGINT'));
      pendingExit = false;
      return;
    }
    // Idle prompt: two Ctrl-C in a row → exit.
    if (pendingExit) {
      stderr.write('\nbye.\n');
      rl.close();
      return;
    }
    pendingExit = true;
    stderr.write('\n(press Ctrl-C again to exit)\n');
    rl.prompt();
  };

  // readline's SIGINT handler differs by platform; we attach our own.
  rl.on('SIGINT', onSigint);
  process.on('SIGINT', onSigint);

  banner(stdout, resolved, opts.profileName);

  // Multi-line accumulator state.
  let inBlock = false;
  let blockLines: string[] = [];

  // Main async iteration over input lines.
  const cleanup = () => {
    process.off('SIGINT', onSigint);
    rl.removeAllListeners('SIGINT');
    rl.close();
  };

  try {
    for await (const line of rl as any as AsyncIterable<string>) {
      pendingExit = false; // any input resets the double-Ctrl-C state

      // Multi-line: """ on its own line opens/closes a block.
      if (line.trim() === '"""') {
        if (inBlock) {
          // closing
          const full = blockLines.join('\n');
          blockLines = [];
          inBlock = false;
          if (full.trim().length === 0) {
            rl.setPrompt('> ');
            rl.prompt();
            continue;
          }
          const code = await runTurn(full);
          if (code === 'exit') break;
        } else {
          inBlock = true;
          blockLines = [];
          rl.setPrompt('... ');
          rl.prompt();
        }
        continue;
      }
      if (inBlock) {
        blockLines.push(line);
        rl.prompt();
        continue;
      }

      const trimmed = line.trim();
      if (trimmed === '') {
        rl.prompt();
        continue;
      }

      if (trimmed.startsWith('/')) {
        const result = await handleSlash(trimmed, {
          session,
          userId: 'local',
          memoryStore: opts.memoryStore,
          pendingMemoryWrites: opts.pendingMemoryWrites,
          sessionStore: opts.store,
          sessionId: opts.sessionId,
        });
        if (result.message) stdout.write(result.message + '\n');
        if (result.kind === 'exit') break;
        rl.prompt();
        continue;
      }

      const code = await runTurn(trimmed);
      if (code === 'exit') break;
    }
  } finally {
    cleanup();
  }

  return 0;

  // ── runTurn ──────────────────────────────────────────────────────────
  async function runTurn(userText: string): Promise<'continue' | 'exit'> {
    session.appendUserMessage(userText);
    let streamedText = '';

    turnAbort = new AbortController();

    const toolNames = opts.noTools
      ? []
      : (opts.toolNamesOverride ?? DEFAULT_TOOLKIT.map(t => t.name));
    const cfg: AgentConfig = createAgentConfig({
      name: opts.profileName ?? 'repl',
      model: session.model,
      maxRounds: opts.maxRounds ?? 12,
      tools: toolNames,
      middlewares: [],
      systemPromptTemplate:
        opts.systemPromptOverride ?? defaultSystemPrompt(toolNames.length > 0),
    });

    const onStreamEvent = (e: LLMStreamEvent) => {
      if (e.type === 'text_delta') {
        streamedText += e.text;
        stdout.write(e.text);
      }
      else if (e.type === 'tool_call_started') stdout.write(`\n[→ ${e.name}(...)]\n`);
      else if (e.type === 'error') stderr.write(`\n[stream error] ${e.error.message}\n`);
    };

    try {
      if (opts.store && opts.sessionId) {
        // Persistence path: runner appends + records usage.
        const result = await runStoredTurn({
          store: opts.store,
          sessionId: opts.sessionId,
          history: session.getHistory(),
          agentConfig: cfg,
          llm,
          streamLLM,
          onStreamEvent,
          userId: 'local',
          signal: turnAbort.signal,
          llmTimeoutMs: resolved.llmTimeoutMs,
          permissions: session.getPermissions(),
          toolApprover: approver,
          cwd,
          allowedPaths,
          initialSearchGate: opts.initialSearchGate,
          userMemoryFetcher: opts.memoryStore ? memoryFetcherFor(opts.memoryStore) : undefined,
          pendingMemoryWrites: opts.pendingMemoryWrites,
        });
        renderFinalAnswer(result.finalAnswer);
        // Reflect the new tail into the in-memory ReplSession.
        for (const m of result.newMessages) {
          // Append via the envelope path so we don't double-append the user
          // message we already pushed at the top of this function.
          // session.getHistory() returned the canonical list; the runner saw
          // it including the new user message, and result.newMessages is the
          // tail beyond that (assistant + tool results). So we just push.
          const env = session.toEnvelope();
          env.history = [...env.history, { ...m }];
          session.loadEnvelope(env);
        }
        stdout.write('\n');
        for (const w of result.warnings) stderr.write(`warning: ${w}\n`);
      } else {
        // No-store path: run the loop directly, merge result back.
        const result = await runReActAgent({
          agentConfig: cfg,
          llm,
          streamLLM,
          onStreamEvent,
          userId: 'local',
          initialMessages: session.getHistory(),
          signal: turnAbort.signal,
          llmTimeoutMs: resolved.llmTimeoutMs,
          permissions: session.getPermissions(),
          toolApprover: approver,
          cwd,
          allowedPaths,
          initialGate: opts.initialSearchGate ? { search: opts.initialSearchGate } : undefined,
          userMemoryFetcher: opts.memoryStore ? memoryFetcherFor(opts.memoryStore) : undefined,
          pendingMemoryWrites: opts.pendingMemoryWrites,
        });
        renderFinalAnswer(result.finalAnswer);
        session.mergeRunResult(result.history);
        stdout.write('\n');
        for (const w of result.warnings) stderr.write(`warning: ${w}\n`);
      }
    } catch (e: any) {
      stderr.write(`\nerror: ${e?.message || e}\n`);
    } finally {
      turnAbort = null;
    }

    // M7: surface staged memory writes after every turn so the user can
    // accept or deny them via /memory.
    if (opts.pendingMemoryWrites && opts.pendingMemoryWrites.size() > 0) {
      stderr.write('\nPending memory writes:\n');
      for (const p of opts.pendingMemoryWrites.list()) {
        stderr.write(`  ${p.id}  ${p.key}: ${p.value}\n`);
      }
      stderr.write('Use `/memory accept <id>` or `/memory deny <id>`.\n');
    }

    rl.setPrompt('> ');
    rl.prompt();
    return 'continue';

    function renderFinalAnswer(finalAnswer: string): void {
      const final = finalAnswer.trim();
      if (!final) return;
      // Direct streaming answers have already been printed delta-by-delta.
      // Terminator-tool answers have not, so print those after the run.
      if (!shouldRenderFinalAnswer(finalAnswer, streamedText, !!opts.noStream)) return;
      if (streamedText && !streamedText.endsWith('\n')) stdout.write('\n');
      stdout.write(finalAnswer);
    }
  }
}

export function shouldRenderFinalAnswer(
  finalAnswer: string,
  streamedText: string,
  noStream: boolean,
): boolean {
  const final = finalAnswer.trim();
  if (!final) return false;
  return noStream || !streamedText.trimEnd().endsWith(final);
}

function banner(out: NodeJS.WritableStream, cfg: ResolvedConfig, profileName?: string): void {
  const profile = profileName ? `  ·  ${profileName}` : '';
  out.write(`Koan  ·  ${cfg.provider}:${cfg.model}${profile}  ·  type /help for commands, /exit to quit\n`);
}

function defaultSystemPrompt(hasTools: boolean): string {
  if (!hasTools) {
    return 'You are a helpful agent. Answer the user directly from your own knowledge. Do not call any tools.';
  }
  return [
    'You are a helpful general-purpose agent with access to filesystem, shell, and web tools.',
    '',
    'Guidelines:',
    '- This is a continuing multi-turn conversation. Use earlier turns as context.',
    '- Use fs.read / fs.list to investigate the working directory before reasoning about file contents.',
    '- Prefer reading actual data over guessing.',
    '- When you have the complete answer, call submit_final_answer with the polished response.',
    '- If a tool returns an error, read it carefully and try a corrected call rather than retrying blindly.',
    '- Some tools (shell, write) may prompt the user for approval. If denied, fall back to another approach.',
  ].join('\n');
}
