/**
 * `koan` CLI entry. Dispatches subcommands.
 *
 *   koan                 → interactive REPL on a TTY; help on a pipe
 *   koan run "<prompt>"  → one-shot
 *   koan chat            → REPL explicitly (works on or off TTY)
 *   koan profile ...     → profile management
 *   koan help            → help
 */
import { parseArgv, flagAsString, flagAsBool, flagAsNumber } from './argv.js';
import { runSubcommand } from './run.js';
import { repl } from './repl.js';
import { resolveConfig, type CLIFlags, type ResolvedConfig } from './config.js';
import { registerDefaultToolkit } from '../tools/index.js';
import { initRegistries } from '../core/registry.js';
import { resolveProfile, type ProfileResolution } from './profile.js';
import { buildEffectiveConfig, type ApproveMode } from './effective.js';
import { profileSubcommand } from './profile-subcommand.js';
import { sessionsSubcommand } from './sessions-subcommand.js';
import { serveSubcommand } from './serve-subcommand.js';
import {
  MemorySessionStore, SqliteSessionStore, defaultSessionsDbPath,
  newSessionId, type SessionStore,
  SqliteUserMemoryStore, InMemoryUserMemoryStore, type UserMemoryStore,
  memoryFetcherFor,
} from '../persistence/index.js';
import { PendingWriteQueue } from '../core/memory.js';
import type { TranscriptSink } from '../transcript/types.js';
import { defaultTranscriptRoot, ensureTranscriptRoot, newTranscriptEvent, openSessionTranscript } from '../transcript/index.js';

const HELP = `usage: koan [<subcommand>] [args]

Subcommands:
  (no args)               Start an interactive REPL (when stdin is a TTY)
  chat                    Start an interactive REPL explicitly
  run "<prompt>"          One-shot prompt → answer
  serve                   Run the HTTP server
  profile <list|show|edit|where>
                          Manage agent profiles
  sessions <list|show|resume|delete|where>
                          Manage persisted sessions
  help                    Show this help

Try \`koan run --help\`, \`koan chat --help\`, \`koan serve --help\`,
\`koan profile --help\`, or \`koan sessions --help\` for subcommand flags.
`;

const CHAT_HELP = `usage: koan chat [flags]

Start an interactive multi-turn REPL.

Flags:
  --profile <name>                Select a profile (default | coding | research | strict | …)
  --provider openai|anthropic     Override provider
  --model <name>                  Override model
  --base-url <url>                Override API base URL
  --timeout <ms>                  Per-LLM-call timeout (default 60000)
  --no-stream                    Disable upstream streaming
  --max-rounds <n>                Max ReAct rounds per turn (default per profile)
  --auto-approve none|safe|all    Tool-approval mode (default: none, prompts)
  --allow-write                   Grant write permission
  --allow-shell                   Grant shell permission
  --allow-network                 Grant network permission
  --allow-path <dir>              Extra path allowed for fs.* tools (repeatable)
  --no-tools                      Disable the default toolkit (knowledge-only)
  --no-persist                    Don't persist this session to the sessions DB
  --transcripts                   Write canonical session JSONL (default with persistence)
  --no-transcripts                Keep SQLite persistence but skip session JSONL
  --transcripts-dir <dir>         Override the transcript root directory
  --continue                      Continue the most recent session
  --resume <id>                   Continue a specific session by id
  -h, --help                      Show this help
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    if (process.stdin.isTTY) {
      return chatSubcommand([], []);
    }
    process.stderr.write(HELP);
    return 0;
  }
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'run':
      return runSubcommand(parseArgv(rest), rest);
    case 'chat':
      return chatSubcommand(rest, rest);
    case 'profile':
      return profileSubcommand(rest);
    case 'sessions':
      return sessionsSubcommand(rest);
    case 'serve':
      return serveSubcommand(rest);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
      return 2;
  }
}

async function chatSubcommand(parsedArgs: string[], rawArgv: string[]): Promise<number> {
  const parsed = parseArgv(parsedArgs);

  if (flagAsBool(parsed, 'help', 'h')) {
    process.stderr.write(CHAT_HELP);
    return 0;
  }

  // Profile resolution.
  let profileResolution: ProfileResolution;
  try {
    profileResolution = resolveProfile({ flag: flagAsString(parsed, 'profile') });
  } catch (e: any) {
    process.stderr.write(`error: ${e.message}\n`);
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
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  const noTools = flagAsBool(parsed, 'no-tools');
  const maxRoundsOverride = flagAsNumber(parsed, 'max-rounds');

  const approveModeStr = (flagAsString(parsed, 'auto-approve') ?? 'none');
  if (!['none', 'safe', 'all'].includes(approveModeStr)) {
    process.stderr.write(`error: --auto-approve must be one of: none, safe, all\n`);
    return 2;
  }
  const approveMode = approveModeStr as ApproveMode;

  if (!noTools) registerDefaultToolkit();
  // Freeze process state after the default registrations. Idempotent.
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

  // --allow-path is a repeatable flag — collect raw.
  const extraPaths: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === '--allow-path') {
      const v = rawArgv[i + 1];
      if (v && !v.startsWith('-')) { extraPaths.push(v); i++; }
    } else if (rawArgv[i].startsWith('--allow-path=')) {
      extraPaths.push(rawArgv[i].slice('--allow-path='.length));
    }
  }
  const cwd = process.cwd();
  const allowedPaths = [cwd, ...extraPaths];

  let approver;
  if (approveMode === 'all') {
    const { autoApprover } = await import('./approve.js');
    approver = autoApprover('allow');
  }

  // ── Persistence (M6) ─────────────────────────────────────────────────
  const noPersist = flagAsBool(parsed, 'no-persist');
  const wantContinue = flagAsBool(parsed, 'continue');
  const resumeId = flagAsString(parsed, 'resume');
  const transcriptRoot = resolved.transcripts.directory ?? defaultTranscriptRoot();

  if (!noPersist && resolved.transcripts.enabled) {
    try {
      await ensureTranscriptRoot(transcriptRoot);
    } catch (e: any) {
      process.stderr.write(`error: cannot initialize transcript directory ${transcriptRoot}: ${e?.message || e}\n`);
      return 1;
    }
  }

  let store: SessionStore;
  let memStore: UserMemoryStore;
  let sessionId: string | undefined;
  let sessionRecord: import('../persistence/session-store.js').SessionRecord | undefined;
  let initialHistory: import('../core/types.js').RawMessage[] | undefined;
  let createdFresh = false;

  if (noPersist) {
    store = new MemorySessionStore();
    memStore = new InMemoryUserMemoryStore();
  } else {
    store = new SqliteSessionStore({ filePath: defaultSessionsDbPath() });
    memStore = new SqliteUserMemoryStore({ filePath: defaultSessionsDbPath() });
  }
  const pendingWrites = new PendingWriteQueue();

  try {
    if (resumeId) {
      const rec = await store.get(resumeId);
      if (!rec) {
        process.stderr.write(`error: session "${resumeId}" not found\n`);
        store.close();
        memStore.close?.();
        return 1;
      }
      sessionId = rec.id;
      sessionRecord = rec;
      initialHistory = rec.messages.map(m => ({ ...m }));
    } else if (wantContinue) {
      const list = await store.list({ limit: 1 });
      if (list.length > 0) {
        const rec = await store.get(list[0].id);
        if (rec) {
          sessionId = rec.id;
          sessionRecord = rec;
          initialHistory = rec.messages.map(m => ({ ...m }));
        }
      } else {
        process.stderr.write('warning: --continue with no prior sessions; starting fresh.\n');
      }
    }

    if (!sessionId) {
      sessionId = newSessionId();
      sessionRecord = await store.create({
        id: sessionId,
        profile: profileResolution.name,
        provider: resolved.provider,
        model: resolved.model,
        cwd,
        permissions: [...effective.permissions],
        usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 },
        messages: [],
      });
      createdFresh = true;
    }
  } catch (e: any) {
    process.stderr.write(`error: ${e.message}\n`);
    store.close();
    memStore.close?.();
    return 1;
  }

  let transcript: TranscriptSink | undefined;
  if (!noPersist && resolved.transcripts.enabled) {
    try {
      sessionRecord ??= await store.get(sessionId);
      if (!sessionRecord) throw new Error(`session "${sessionId}" could not be reloaded`);
      transcript = await openSessionTranscript(sessionRecord, transcriptRoot);
    } catch (e: any) {
      if (createdFresh) await store.delete(sessionId).catch(() => false);
      process.stderr.write(`error: cannot initialize transcript: ${e?.message || e}\n`);
      store.close();
      memStore.close?.();
      return 1;
    }
  }

  process.stderr.write(`profile: ${profileResolution.name} (${profileResolution.source})\n`);
  if (!noPersist) {
    process.stderr.write(`session: ${sessionId}${initialHistory && initialHistory.length ? ` (resumed, ${initialHistory.length} messages)` : ''}\n`);
    if (transcript) process.stderr.write(`transcript: ${transcript.path}\n`);
  }

  try {
    return await repl({
      config: resolved,
      initialPermissions: effective.permissions,
      cwd,
      allowedPaths,
      maxRounds: effective.maxRounds,
      noTools,
      noStream: flagAsBool(parsed, 'no-stream'),
      approver,
      systemPromptOverride: effective.systemPrompt,
      toolNamesOverride: effective.toolNames,
      profileName: profileResolution.name,
      initialSearchGate: profile.defaultSearchGate,
      store,
      sessionId,
      initialHistory,
      // M7: across-conv memory is off by default — only wire the store
      // through when the profile opts in (memory_mechanism.md §8).
      memoryStore: profile.acrossConversationMemory ? memStore : undefined,
      pendingMemoryWrites: pendingWrites,
      transcript,
    });
  } finally {
    if (transcript) {
      try {
        await transcript.append([newTranscriptEvent('session.closed', { reason: 'chat_exit' })]);
        await transcript.close();
      } catch (e: any) {
        process.stderr.write(`warning: transcript close failed at ${transcript.path}: ${e?.message || e}\n`);
      }
    }
    store.close();
    memStore.close?.();
  }
}
