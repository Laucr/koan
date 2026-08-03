/**
 * `koan run "<prompt>"` — one-shot prompt → final answer to stdout.
 *
 * Wires in M5 profiles + M6 persistence. By default each run creates a
 * session record in ~/.local/share/koan/sessions.db so the user can later
 * list/resume/inspect. `--no-persist` disables that. `--continue` rehydrates
 * the most recent session before starting.
 */
import path from 'node:path';
import { createAgentConfig } from '../config/agent-loader.js';
import { registerDefaultToolkit } from '../tools/index.js';
import { initRegistries } from '../core/registry.js';
import type { LLMStreamEvent } from '../core/streaming.js';
import type { AgentConfig } from '../core/types.js';
import type { ToolApprover } from '../core/loop.js';
import { resolveConfig, type CLIFlags, type ResolvedConfig } from './config.js';
import { buildLLMClient, buildStreamingLLMClient } from './provider.js';
import { type ParsedArgv, flagAsString, flagAsBool, flagAsNumber } from './argv.js';
import { createTTYApprover, autoApprover } from './approve.js';
import { resolveProfile, type ProfileResolution } from './profile.js';
import { buildEffectiveConfig, type ApproveMode } from './effective.js';
import {
  MemorySessionStore, SqliteSessionStore, defaultSessionsDbPath,
  newSessionId, type SessionStore,
  SqliteUserMemoryStore, type UserMemoryStore,
  memoryFetcherFor,
} from '../persistence/index.js';
import { InMemoryUserMemoryStore } from '../persistence/index.js';
import { PendingWriteQueue } from '../core/memory.js';
import { runTurn, recordToInitialMessages } from '../persistence/runner.js';
import type { TranscriptSink } from '../transcript/types.js';
import { defaultTranscriptRoot, ensureTranscriptRoot, newTranscriptEvent, openSessionTranscript } from '../transcript/index.js';

export interface RunSubcommandOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  abortController?: AbortController;
  approver?: ToolApprover;
  /** Inject a store (used by tests). Defaults to SqliteSessionStore on disk,
   *  or MemorySessionStore when --no-persist is set. */
  store?: SessionStore;
  /** Inject a transcript sink for tests/library callers. */
  transcript?: TranscriptSink;
}

const HELP = `usage: koan run "<prompt>" [flags]

Run a single prompt against the configured LLM and print the answer.

Flags:
  --profile <name>                Select a profile (default | coding | research | strict | …)
  --provider openai|anthropic     Override provider
  --model <name>                  Override model
  --base-url <url>                Override API base URL
  --timeout <ms>                  Per-LLM-call timeout (default 60000)
  --no-stream                     Disable streaming output
  --max-rounds <n>                Max ReAct rounds (default per profile)
  --auto-approve none|safe|all    Tool-approval mode (default: none, prompts)
  --allow-write                   Grant write permission for this run
  --allow-shell                   Grant shell permission for this run
  --allow-network                 Grant network permission for this run
  --allow-path <dir>              Extra path allowed for fs.* tools (repeatable)
  --no-tools                      Disable the default toolkit (knowledge-only)
  --no-persist                    Don't write this run to the sessions DB
  --transcripts                   Write canonical session JSONL (default with persistence)
  --no-transcripts                Keep SQLite persistence but skip session JSONL
  --transcripts-dir <dir>         Override the transcript root directory
  --continue                      Continue the most recent session (rehydrates history)
  --resume <id>                   Continue a specific session by id
  -h, --help                      Show this help

Configuration:
  Profile selection: --profile > $KOAN_PROFILE > ./.koan.yaml > "default"
  ~/.config/koan/config.json (non-secret defaults)
  ~/.config/koan/profiles/*.yaml (user-installed profiles)
  ~/.local/share/koan/sessions.db (default sessions database)
  env: OPENAI_API_KEY / ANTHROPIC_API_KEY / KOAN_API_KEY (required)
`;

function parseApproveMode(v: string | undefined): ApproveMode {
  if (!v) return 'none';
  if (v === 'none' || v === 'safe' || v === 'all') return v;
  throw new Error(`--auto-approve must be one of: none, safe, all (got "${v}")`);
}

function collectAllowPaths(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-path') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) { out.push(v); i++; }
    } else if (argv[i].startsWith('--allow-path=')) {
      out.push(argv[i].slice('--allow-path='.length));
    }
  }
  return out;
}

export async function runSubcommand(
  parsed: ParsedArgv,
  rawArgv: string[],
  opts: RunSubcommandOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  if (flagAsBool(parsed, 'help', 'h')) {
    stderr.write(HELP);
    return 0;
  }

  const prompt = parsed.positional.join(' ').trim();
  if (!prompt) {
    stderr.write('error: a prompt is required\n\n' + HELP);
    return 2;
  }

  let profileResolution: ProfileResolution;
  try {
    profileResolution = resolveProfile({ flag: flagAsString(parsed, 'profile') });
  } catch (e: any) {
    stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  const profile = profileResolution.profile;

  const flags: CLIFlags = {
    provider: (flagAsString(parsed, 'provider') ?? profile.provider) as any,
    model: flagAsString(parsed, 'model') ?? profile.model,
    baseURL: flagAsString(parsed, 'base-url', 'baseUrl'),
    llmTimeoutMs: flagAsNumber(parsed, 'timeout', 'llm-timeout-ms'),
    profile: profileResolution.name,
    transcriptEnabled: flagAsBool(parsed, 'no-transcripts')
      ? false
      : flagAsBool(parsed, 'transcripts') ? true : undefined,
    transcriptDirectory: flagAsString(parsed, 'transcripts-dir'),
  };
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig({ flags });
  } catch (e: any) {
    stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  let approveMode: ApproveMode;
  try {
    approveMode = parseApproveMode(flagAsString(parsed, 'auto-approve'));
  } catch (e: any) {
    stderr.write(`error: ${e.message}\n`);
    return 2;
  }

  const noStream = flagAsBool(parsed, 'no-stream');
  const noTools = flagAsBool(parsed, 'no-tools');
  const noPersist = flagAsBool(parsed, 'no-persist');
  const wantContinue = flagAsBool(parsed, 'continue');
  const resumeId = flagAsString(parsed, 'resume');
  const maxRoundsOverride = flagAsNumber(parsed, 'max-rounds');

  if (!noTools) registerDefaultToolkit();
  // Freeze process state after all built-in registrations. Idempotent —
  // safe to call across multiple `koan run` invocations in one process
  // (e.g. tests or library users that re-enter the CLI).
  initRegistries();

  const effective = buildEffectiveConfig({
    profile,
    approveMode,
    allowWrite: flagAsBool(parsed, 'allow-write'),
    allowShell: flagAsBool(parsed, 'allow-shell'),
    allowNetwork: flagAsBool(parsed, 'allow-network'),
    noTools,
    maxRoundsOverride,
  });

  const extraPaths = collectAllowPaths(rawArgv).map(p => path.resolve(p));
  const allowedPaths = [process.cwd(), ...extraPaths];

  let approver: ToolApprover | undefined = opts.approver;
  if (!approver) {
    if (approveMode === 'all') approver = autoApprover('allow');
    else if (process.stdin.isTTY) approver = createTTYApprover({ output: stderr });
  }

  // ── Session / store setup ────────────────────────────────────────────
  let store: SessionStore;
  let memStore: UserMemoryStore;
  let closeStore = false;
  if (opts.store) {
    store = opts.store;
    memStore = new InMemoryUserMemoryStore();
  } else if (noPersist) {
    store = new MemorySessionStore();
    memStore = new InMemoryUserMemoryStore();
    closeStore = true;
  } else {
    store = new SqliteSessionStore({ filePath: defaultSessionsDbPath() });
    memStore = new SqliteUserMemoryStore({ filePath: defaultSessionsDbPath() });
    closeStore = true;
  }
  const pendingWrites = new PendingWriteQueue();
  const transcriptRoot = resolved.transcripts.directory ?? defaultTranscriptRoot();
  if (!noPersist && resolved.transcripts.enabled && !opts.transcript && !opts.store) {
    try {
      await ensureTranscriptRoot(transcriptRoot);
    } catch (e: any) {
      stderr.write(`error: cannot initialize transcript directory ${transcriptRoot}: ${e?.message || e}\n`);
      if (closeStore) { store.close(); memStore.close?.(); }
      return 1;
    }
  }

  // History the loop will see. Either: rehydrate from a prior session and
  // append the new user message, or start fresh with just the user message.
  let sessionId: string;
  let sessionRecord: import('../persistence/session-store.js').SessionRecord | undefined;
  let createdFresh = false;
  let priorHistory: import('../core/types.js').RawMessage[] = [];
  try {
    if (resumeId) {
      const rec = await store.get(resumeId);
      if (!rec) {
        stderr.write(`error: session "${resumeId}" not found\n`);
        return 1;
      }
      sessionId = rec.id;
      sessionRecord = rec;
      priorHistory = recordToInitialMessages(rec);
    } else if (wantContinue) {
      const list = await store.list({ limit: 1 });
      if (list.length === 0) {
        stderr.write('warning: --continue with no prior sessions; starting fresh.\n');
      }
      if (list.length > 0) {
        const rec = await store.get(list[0].id);
        if (!rec) {
          stderr.write(`error: latest session "${list[0].id}" was indexed but could not be loaded\n`);
          return 1;
        }
        sessionId = rec.id;
        sessionRecord = rec;
        priorHistory = recordToInitialMessages(rec);
      } else {
        sessionId = await createFreshSession();
      }
    } else {
      sessionId = await createFreshSession();
    }
  } catch (e: any) {
    stderr.write(`error: ${e.message}\n`);
    if (closeStore) store.close();
    return 1;
  }

  async function createFreshSession(): Promise<string> {
    const id = newSessionId();
    sessionRecord = await store.create({
      id,
      profile: profileResolution.name,
      provider: resolved.provider,
      model: resolved.model,
      cwd: process.cwd(),
      permissions: [...effective.permissions],
      usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 },
      messages: [],
    });
    createdFresh = true;
    return id;
  }

  let transcript = opts.transcript;
  if (!transcript && !opts.store && !noPersist && resolved.transcripts.enabled) {
    try {
      sessionRecord ??= await store.get(sessionId);
      if (!sessionRecord) throw new Error(`session "${sessionId}" could not be reloaded`);
      transcript = await openSessionTranscript(sessionRecord, transcriptRoot);
      stderr.write(`transcript: ${transcript.path}\n`);
    } catch (e: any) {
      if (createdFresh) await store.delete(sessionId).catch(() => false);
      stderr.write(`error: cannot initialize transcript: ${e?.message || e}\n`);
      if (closeStore) { store.close(); memStore.close?.(); }
      return 1;
    }
  }

  const history = [...priorHistory, { role: 'user' as const, content: prompt }];

  // SIGINT handling.
  const abortCtrl = opts.abortController ?? new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      stderr.write('\n[interrupted; aborting...]\n');
      abortCtrl.abort(new Error('SIGINT'));
    } else {
      stderr.write('\n[force exiting]\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  const cfg: AgentConfig = createAgentConfig({
    name: profileResolution.name,
    model: resolved.model,
    maxRounds: effective.maxRounds,
    tools: effective.toolNames,
    middlewares: [],
    systemPromptTemplate: effective.systemPrompt,
  });

  let exitCode = 0;
  try {
    const result = await runTurn({
      store,
      sessionId,
      history,
      agentConfig: cfg,
      llm: noStream ? buildLLMClient(resolved) : undefined,
      streamLLM: noStream ? undefined : buildStreamingLLMClient(resolved),
      onStreamEvent: (e: LLMStreamEvent) => {
        if (e.type === 'text_delta') stdout.write(e.text);
        else if (e.type === 'tool_call_started') stdout.write(`\n[→ ${e.name}(...)]\n`);
        else if (e.type === 'error') stderr.write(`\n[stream error] ${e.error.message}\n`);
      },
      userId: 'local',
      signal: abortCtrl.signal,
      llmTimeoutMs: resolved.llmTimeoutMs,
      permissions: effective.permissions,
      toolApprover: approver,
      cwd: process.cwd(),
      allowedPaths,
      initialSearchGate: profile.defaultSearchGate,
      // M7: only inject the cross-conv memory pipeline when the profile
      // explicitly opts in (memory_mechanism.md §8: off by default).
      userMemoryFetcher: profile.acrossConversationMemory ? memoryFetcherFor(memStore) : undefined,
      pendingMemoryWrites: pendingWrites,
      transcript,
    });

    if (noStream) stdout.write(result.finalAnswer);
    if (!result.finalAnswer.endsWith('\n')) stdout.write('\n');

    if (!noPersist) {
      stderr.write(`session: ${sessionId}\n`);
    }

    // M7: surface staged memory writes. The user can accept/deny via
    // `koan memory accept <pendingId> <key> <value>` — but in one-shot
    // mode we just list them; they don't persist automatically.
    if (pendingWrites.size() > 0) {
      stderr.write('\nPending memory writes (not yet persisted):\n');
      for (const p of pendingWrites.list()) {
        stderr.write(`  ${p.id}  ${p.key}: ${p.value}\n`);
      }
      stderr.write('Accept with: koan memory accept ' + pendingWrites.list().map(p => p.id).join(' ') + '\n');
    }

    if (abortCtrl.signal.aborted) {
      stderr.write('aborted\n');
      exitCode = 130;
    } else if (result.warnings.length) {
      for (const w of result.warnings) stderr.write(`warning: ${w}\n`);
    }
  } catch (e: any) {
    stderr.write(`error: ${e?.message || e}\n`);
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    if (transcript) {
      try {
        await transcript.append([newTranscriptEvent('session.closed', { exit_code: exitCode })]);
        await transcript.close();
      } catch (e: any) {
        stderr.write(`warning: transcript close failed at ${transcript.path}: ${e?.message || e}\n`);
      }
    }
    if (closeStore) {
      store.close();
      memStore.close?.();
    }
  }
  return exitCode;
}
