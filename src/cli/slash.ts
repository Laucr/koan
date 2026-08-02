/**
 * Slash-command handlers for the REPL.
 *
 * Each handler returns a `SlashResult`. The REPL loop consults that result
 * to decide whether to keep going, exit, or print something to the user.
 *
 * Handlers are deliberately small and synchronous-where-possible so they're
 * trivial to test.
 */
import type { ReplSession } from './session.js';
import { saveSession, loadSession } from './session.js';
import type { ToolPermission } from '../core/types.js';
import type { UserMemoryStore } from '../persistence/user-memory-store.js';
import type { PendingWriteQueue } from '../core/memory.js';
import type { SessionStore } from '../persistence/session-store.js';
import { costFor, formatCost } from '../obs/cost.js';

export type SlashResult =
  | { kind: 'continue'; message?: string }
  | { kind: 'exit'; message?: string }
  | { kind: 'error'; message: string };

export interface SlashContext {
  session: ReplSession;
  /** Owner id for memory commands. Defaults to 'local' in the CLI. */
  userId?: string;
  /** Cross-conversation memory store. Required for /memory list|forget|clear. */
  memoryStore?: UserMemoryStore;
  /** Pending-write queue. Required for /memory accept|deny. */
  pendingMemoryWrites?: PendingWriteQueue;
  /** Session store (required for /cost). */
  sessionStore?: SessionStore;
  /** Current session id (required for /cost). */
  sessionId?: string;
}

const HELP_TEXT = `Slash commands:
  /help                 Show this help
  /exit, /quit          End the session
  /clear                Wipe conversation history (keep permissions, model)
  /history              Show conversation history
  /save <path>          Write the session to a JSON file
  /load <path>          Replace the session with one loaded from JSON
  /permissions          Show currently granted permissions
  /permissions add <p>      Grant a permission (read|write|shell|network)
  /permissions remove <p>   Revoke a permission
  /model <name>         Switch model for subsequent turns
  /memory               Show stored user memories
  /memory pending           List staged (unconfirmed) writes
  /memory accept <id>       Persist a staged write
  /memory deny <id>         Drop a staged write
  /memory forget <key>      Delete a stored memory by key
  /memory clear             Delete ALL stored memories (asks no questions)
  /cost                 Show tokens consumed + estimated USD cost for this session

Input:
  - Plain text is sent to the agent.
  - Open a triple-quoted block with """ on its own line to enter multi-line
    input; close with """ on its own line.
  - Ctrl-C aborts an in-flight run (twice in a row exits).
  - Ctrl-D exits.
`;

const VALID_PERMISSIONS: ToolPermission[] = ['read', 'write', 'shell', 'network'];

export async function handleSlash(input: string, ctx: SlashContext): Promise<SlashResult> {
  const trimmed = input.trim();
  // Split into command + rest, preserving the rest as-is for paths/text.
  const spaceIdx = trimmed.search(/\s/);
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case '/help':
    case '/?':
      return { kind: 'continue', message: HELP_TEXT };

    case '/exit':
    case '/quit':
      return { kind: 'exit', message: 'bye.' };

    case '/clear':
      ctx.session.clear();
      return { kind: 'continue', message: 'history cleared.' };

    case '/history':
      return { kind: 'continue', message: ctx.session.describe() };

    case '/save': {
      if (!rest) return { kind: 'error', message: '/save needs a path' };
      try {
        await saveSession(ctx.session, rest);
        return { kind: 'continue', message: `saved to ${rest}` };
      } catch (e: any) {
        return { kind: 'error', message: `save failed: ${e?.message || e}` };
      }
    }

    case '/load': {
      if (!rest) return { kind: 'error', message: '/load needs a path' };
      try {
        await loadSession(ctx.session, rest);
        return { kind: 'continue', message: `loaded from ${rest}` };
      } catch (e: any) {
        return { kind: 'error', message: `load failed: ${e?.message || e}` };
      }
    }

    case '/permissions':
    case '/perms': {
      if (!rest) {
        const list = [...ctx.session.getPermissions()];
        return {
          kind: 'continue',
          message: list.length ? `granted: ${list.join(', ')}` : '(no permissions granted)',
        };
      }
      const sub = rest.split(/\s+/);
      const action = sub[0]?.toLowerCase();
      const perm = sub[1]?.toLowerCase() as ToolPermission | undefined;
      if (!perm || !VALID_PERMISSIONS.includes(perm)) {
        return { kind: 'error', message: `unknown permission "${perm}"; valid: ${VALID_PERMISSIONS.join(', ')}` };
      }
      if (action === 'add') {
        const cur = ctx.session.getPermissions();
        cur.add(perm);
        ctx.session.setPermissions(cur);
        return { kind: 'continue', message: `granted: ${perm}` };
      }
      if (action === 'remove' || action === 'rm') {
        const cur = ctx.session.getPermissions();
        cur.delete(perm);
        ctx.session.setPermissions(cur);
        return { kind: 'continue', message: `revoked: ${perm}` };
      }
      return { kind: 'error', message: `unknown action "${action}"; try /permissions add|remove <perm>` };
    }

    case '/model': {
      if (!rest) {
        return { kind: 'continue', message: `current model: ${ctx.session.model}` };
      }
      ctx.session.model = rest;
      return { kind: 'continue', message: `model switched to: ${rest}` };
    }

    case '/memory':
    case '/mem': {
      const sub = rest.split(/\s+/);
      const action = (sub[0] ?? '').toLowerCase();
      const userId = ctx.userId ?? 'local';

      // No args → list stored memories.
      if (!action) {
        if (!ctx.memoryStore) {
          return { kind: 'continue', message: '(memory store not wired)' };
        }
        const entries = await ctx.memoryStore.list(userId);
        if (entries.length === 0) return { kind: 'continue', message: '(no memories yet)' };
        const lines = entries.map(e => `  ${e.key.padEnd(24)} ${e.value}`);
        return { kind: 'continue', message: 'Stored memories:\n' + lines.join('\n') };
      }

      if (action === 'pending') {
        if (!ctx.pendingMemoryWrites || ctx.pendingMemoryWrites.size() === 0) {
          return { kind: 'continue', message: '(no pending writes)' };
        }
        const items = ctx.pendingMemoryWrites.list();
        const lines = items.map(p => `  ${p.id.padEnd(8)} ${p.key.padEnd(24)} ${p.value}`);
        return { kind: 'continue', message: 'Pending writes:\n' + lines.join('\n') };
      }

      if (action === 'accept') {
        const id = sub[1];
        if (!id) return { kind: 'error', message: '/memory accept <id>' };
        if (!ctx.pendingMemoryWrites || !ctx.memoryStore) {
          return { kind: 'error', message: 'memory store not wired' };
        }
        const entry = ctx.pendingMemoryWrites.take(id);
        if (!entry) return { kind: 'error', message: `no pending write "${id}"` };
        await ctx.memoryStore.set(entry.owner, entry.key, entry.value);
        return { kind: 'continue', message: `saved: ${entry.key}` };
      }

      if (action === 'deny' || action === 'drop') {
        const id = sub[1];
        if (!id) return { kind: 'error', message: '/memory deny <id>' };
        if (!ctx.pendingMemoryWrites) {
          return { kind: 'error', message: 'memory store not wired' };
        }
        const dropped = ctx.pendingMemoryWrites.drop(id);
        return dropped
          ? { kind: 'continue', message: `dropped ${id}` }
          : { kind: 'error', message: `no pending write "${id}"` };
      }

      if (action === 'forget') {
        const key = sub[1];
        if (!key) return { kind: 'error', message: '/memory forget <key>' };
        if (!ctx.memoryStore) {
          return { kind: 'error', message: 'memory store not wired' };
        }
        const ok = await ctx.memoryStore.forget(userId, key);
        return ok
          ? { kind: 'continue', message: `forgot ${key}` }
          : { kind: 'error', message: `no memory with key "${key}"` };
      }

      if (action === 'clear') {
        if (!ctx.memoryStore) {
          return { kind: 'error', message: 'memory store not wired' };
        }
        // Drop pending too so the user can't accidentally accept a stale id.
        ctx.pendingMemoryWrites?.clear();
        const n = await ctx.memoryStore.clear(userId);
        return { kind: 'continue', message: `cleared ${n} memor${n === 1 ? 'y' : 'ies'}` };
      }

      return { kind: 'error', message: `unknown /memory action "${action}". Try /help.` };
    }

    case '/cost': {
      if (!ctx.sessionStore || !ctx.sessionId) {
        return { kind: 'continue', message: '(cost requires a persisted session)' };
      }
      const rec = await ctx.sessionStore.get(ctx.sessionId);
      if (!rec) return { kind: 'error', message: 'session not found' };
      const usd = costFor(rec.model, rec.usage.promptTokens, rec.usage.completionTokens);
      const lines = [
        `model:        ${rec.model}`,
        `prompt:       ${rec.usage.promptTokens} tokens`,
        `completion:   ${rec.usage.completionTokens} tokens`,
        `rounds:       ${rec.usage.rounds}`,
        `tool calls:   ${rec.usage.toolCalls}`,
        `estimated:    ${formatCost(usd)}`,
      ];
      return { kind: 'continue', message: lines.join('\n') };
    }

    default:
      return { kind: 'error', message: `unknown command: ${cmd}. Try /help.` };
  }
}

export const __helpText = HELP_TEXT;
