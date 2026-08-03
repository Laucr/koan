/**
 * `koan sessions <subcommand>` — inspect persisted sessions.
 *
 *   koan sessions list                 list newest first
 *   koan sessions show <id>            full record as text
 *   koan sessions resume <id>          drop into REPL with that session loaded
 *   koan sessions delete <id>          delete (no prompt — be careful)
 *   koan sessions where                print the DB path
 */
import path from 'node:path';
import fs from 'node:fs';
import { SqliteSessionStore, defaultSessionsDbPath } from '../persistence/index.js';
import type { SessionStore } from '../persistence/index.js';
import { repl } from './repl.js';
import { resolveConfig, resolveTranscriptConfig } from './config.js';
import { registerDefaultToolkit } from '../tools/index.js';
import { BUILTIN_PROFILES, resolveProfile } from './profile.js';
import { buildEffectiveConfig } from './effective.js';
import type { TranscriptFormat, TranscriptSink } from '../transcript/types.js';
import {
  defaultTranscriptRoot, ensureTranscriptRoot, exportSessionJsonl, newTranscriptEvent,
  openSessionTranscript, transcriptPathFor, writeSessionExport,
} from '../transcript/index.js';

const HELP = `usage: koan sessions <subcommand>

Subcommands:
  list [--limit <n>] [--profile <name>]   List sessions, newest first
  show <id>                               Show a session's metadata + history
  resume <id>                             Open the session in the REPL
  delete <id>                             Permanently delete a session
  export <id> --format koan|codex|claude [--output <path>]
                                          Export a session as JSONL
  where [--transcripts]                   Print the DB path or transcript root

Database:
  $XDG_DATA_HOME/koan/sessions.db or ~/.local/share/koan/sessions.db

Transcripts:
  $XDG_DATA_HOME/koan/transcripts or ~/.local/share/koan/transcripts
`;

export async function sessionsSubcommand(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const dbPath = defaultSessionsDbPath();

  switch (sub) {
    case 'where':
      if (argv.includes('--transcripts')) {
        try {
          const cfg = resolveTranscriptConfig();
          process.stdout.write((cfg.directory ?? defaultTranscriptRoot()) + '\n');
        } catch (e: any) {
          process.stderr.write(`error: ${e?.message || e}\n`);
          return 1;
        }
      } else {
        process.stdout.write(dbPath + '\n');
      }
      return 0;

    case 'export': {
      const id = argv[1];
      if (!id) {
        process.stderr.write('error: `koan sessions export` needs an id\n');
        return 2;
      }
      const format = parseValue(argv, '--format') as TranscriptFormat | undefined;
      if (!format || !['koan', 'codex', 'claude'].includes(format)) {
        process.stderr.write('error: --format must be one of: koan, codex, claude\n');
        return 2;
      }
      const store: SessionStore = new SqliteSessionStore({ filePath: dbPath });
      try {
        const record = await store.get(id);
        if (!record) {
          process.stderr.write(`error: session "${id}" not found\n`);
          return 1;
        }
        const output = parseValue(argv, '--output');
        if (output) {
          await writeSessionExport(record, format, output);
          process.stdout.write(`${path.resolve(output)}\n`);
        } else {
          process.stdout.write(exportSessionJsonl(record, format));
        }
        return 0;
      } catch (e: any) {
        process.stderr.write(`error: failed to export session "${id}" as ${format}: ${e?.message || e}\n`);
        return 1;
      } finally {
        store.close();
      }
    }

    case 'list': {
      const store: SessionStore = new SqliteSessionStore({ filePath: dbPath });
      try {
        const limit = parseLimit(argv);
        const profile = parseValue(argv, '--profile');
        const rows = await store.list({ limit, profile });
        if (rows.length === 0) {
          process.stdout.write('(no sessions yet)\n');
          return 0;
        }
        for (const r of rows) {
          const ts = new Date(r.updatedAt).toISOString().replace('T', ' ').slice(0, 19);
          const id = r.id.padEnd(24);
          const prof = r.profile.padEnd(12);
          const meta = `${r.messageCount} msgs, ${r.tokensTotal} tokens`.padEnd(28);
          process.stdout.write(`${ts}  ${id} ${prof} ${meta} ${r.title}\n`);
        }
        return 0;
      } finally {
        store.close();
      }
    }

    case 'show': {
      const id = argv[1];
      if (!id) {
        process.stderr.write('error: `koan sessions show` needs an id\n');
        return 2;
      }
      const store: SessionStore = new SqliteSessionStore({ filePath: dbPath });
      try {
        const rec = await store.get(id);
        if (!rec) {
          process.stderr.write(`error: session "${id}" not found\n`);
          return 1;
        }
        const lines: string[] = [];
        lines.push(`id:          ${rec.id}`);
        lines.push(`title:       ${rec.title ?? ''}`);
        lines.push(`profile:     ${rec.profile}`);
        lines.push(`provider:    ${rec.provider}`);
        lines.push(`model:       ${rec.model}`);
        lines.push(`cwd:         ${rec.cwd}`);
        lines.push(`permissions: ${rec.permissions.join(', ') || '(none)'}`);
        lines.push(`created:     ${rec.createdAt}`);
        lines.push(`updated:     ${rec.updatedAt}`);
        lines.push(`usage:       prompt=${rec.usage.promptTokens}  completion=${rec.usage.completionTokens}  rounds=${rec.usage.rounds}  tool_calls=${rec.usage.toolCalls}`);
        lines.push(`messages:    ${rec.messages.length}`);
        lines.push('');
        lines.push('--- transcript ---');
        rec.messages.forEach((m, i) => {
          const preview = String(m.content || '').replace(/\s+/g, ' ').slice(0, 200);
          const meta = m.toolCalls?.length ? ` [+${m.toolCalls.length} tool call${m.toolCalls.length === 1 ? '' : 's'}]` : '';
          lines.push(`[${i}] ${m.role}: ${preview}${meta}`);
        });
        process.stdout.write(lines.join('\n') + '\n');
        return 0;
      } finally {
        store.close();
      }
    }

    case 'delete': {
      const id = argv[1];
      if (!id) {
        process.stderr.write('error: `koan sessions delete` needs an id\n');
        return 2;
      }
      const store: SessionStore = new SqliteSessionStore({ filePath: dbPath });
      try {
        const record = await store.get(id);
        if (!record) {
          process.stderr.write(`session "${id}" did not exist\n`);
          return 1;
        }
        let root: string;
        try {
          const cfg = resolveTranscriptConfig();
          root = cfg.directory ?? defaultTranscriptRoot();
        } catch (e: any) {
          process.stderr.write(`error: ${e?.message || e}\n`);
          return 1;
        }
        const transcriptPath = transcriptPathFor(record.id, record.createdAt, root);
        const tombstone = `${transcriptPath}.deleting-${process.pid}-${Date.now()}`;
        let staged = false;
        try {
          await fs.promises.rename(transcriptPath, tombstone);
          staged = true;
        } catch (e: any) {
          if (e?.code !== 'ENOENT') {
            process.stderr.write(`error: could not stage transcript deletion: ${e?.message || e}\n`);
            return 1;
          }
        }
        try {
          const ok = await store.delete(id);
          if (!ok) throw new Error('session disappeared during deletion');
        } catch (e: any) {
          if (staged) await fs.promises.rename(tombstone, transcriptPath).catch(() => undefined);
          process.stderr.write(`error: failed to delete session "${id}": ${e?.message || e}\n`);
          return 1;
        }
        if (staged) {
          try {
            await fs.promises.unlink(tombstone);
          } catch (e: any) {
            process.stderr.write(`error: session deleted, but transcript cleanup failed at ${tombstone}: ${e?.message || e}\n`);
            return 1;
          }
        }
        process.stdout.write(`deleted session: ${id}\ntranscript: ${staged ? transcriptPath : '(not found)'}\n`);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'resume': {
      const id = argv[1];
      if (!id) {
        process.stderr.write('error: `koan sessions resume` needs an id\n');
        return 2;
      }
      const store: SessionStore = new SqliteSessionStore({ filePath: dbPath });
      try {
        const rec = await store.get(id);
        if (!rec) {
          process.stderr.write(`error: session "${id}" not found\n`);
          return 1;
        }
        // Best-effort: pick the profile the session was opened with, fall
        // back to default if it's no longer installed.
        const builtin = BUILTIN_PROFILES[rec.profile];
        const resolution = builtin
          ? { name: rec.profile, source: 'flag' as const, profile: builtin }
          : resolveProfile({ flag: rec.profile });
        const profile = resolution.profile;

        let resolved;
        try {
          resolved = resolveConfig({ flags: { provider: rec.provider as any, model: rec.model } });
        } catch (e: any) {
          process.stderr.write(`error: ${e.message}\n`);
          return 1;
        }

        registerDefaultToolkit();
        const effective = buildEffectiveConfig({
          profile,
          approveMode: 'none',
        });
        // Permissions snapshot from the record itself.
        const permissions = new Set(rec.permissions);

        process.stderr.write(`profile: ${resolution.name} (resumed)\n`);
        process.stderr.write(`session: ${rec.id} (${rec.messages.length} messages)\n`);

        const transcriptConfig = resolveTranscriptConfig({ flags: {
          transcriptEnabled: argv.includes('--no-transcripts')
            ? false
            : argv.includes('--transcripts') ? true : undefined,
          transcriptDirectory: parseValue(argv, '--transcripts-dir'),
        } });
        let transcript: TranscriptSink | undefined;
        if (transcriptConfig.enabled) {
          const root = transcriptConfig.directory ?? defaultTranscriptRoot();
          await ensureTranscriptRoot(root);
          transcript = await openSessionTranscript(rec, root);
          process.stderr.write(`transcript: ${transcript.path}\n`);
        }
        try {
          return await repl({
            config: resolved,
            initialPermissions: permissions,
            cwd: process.cwd(),
            allowedPaths: [process.cwd()],
            maxRounds: effective.maxRounds,
            systemPromptOverride: effective.systemPrompt,
            toolNamesOverride: effective.toolNames,
            profileName: resolution.name,
            initialSearchGate: profile.defaultSearchGate,
            store,
            sessionId: rec.id,
            initialHistory: rec.messages.map(m => ({ ...m })),
            transcript,
          });
        } finally {
          if (transcript) {
            await transcript.append([newTranscriptEvent('session.closed', { reason: 'chat_exit' })]).catch(() => undefined);
            await transcript.close().catch(() => undefined);
          }
        }
      } finally {
        store.close();
      }
    }

    default:
      process.stderr.write(`unknown sessions subcommand: ${sub}\n\n${HELP}`);
      return 2;
  }
}

function parseLimit(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      const v = argv[i + 1];
      if (v) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    } else if (argv[i].startsWith('--limit=')) {
      const n = Number(argv[i].slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 50;
}

function parseValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}
