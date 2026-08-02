/**
 * Build the per-user "user_memories" template var by reading from a
 * UserMemoryStore. Caller supplies the store + user id; the returned
 * fetcher matches the shape AcrossConversationMemory expects.
 *
 * The output is a `Record<string, string>` where:
 *   - `user_memories`     pretty-printed `key: value` lines (or '(none)')
 *   - `user_memories_count` count as a string
 *   - each individual memory key is exposed as `mem_<key>` for advanced
 *     templates that want to reference one entry directly.
 *
 * The fetcher reads on every call but the AcrossConversationMemory wrapper
 * caches hits for the request's lifetime — cache-hits-not-misses, per
 * memory_mechanism.md §7.
 */
import type { UserMemoryStore } from './user-memory-store.js';

export function memoryFetcherFor(store: UserMemoryStore): (userId: string) => Promise<Record<string, string>> {
  return async (userId: string) => {
    const entries = await store.list(userId);
    const out: Record<string, string> = {};
    if (entries.length === 0) {
      out.user_memories = '(none)';
      out.user_memories_count = '0';
      return out;
    }
    const lines = entries.map(e => `- ${e.key}: ${e.value}`);
    out.user_memories = lines.join('\n');
    out.user_memories_count = String(entries.length);
    for (const e of entries) {
      out[`mem_${e.key}`] = e.value;
    }
    return out;
  };
}
