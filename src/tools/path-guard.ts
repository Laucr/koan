/**
 * Path-allowlist enforcement shared by all fs.* tools.
 *
 * Rules (deliberately strict):
 *   - Argument paths are resolved against `ctx.cwd`.
 *   - Resolved absolute paths must be inside one of `ctx.allowedPaths`.
 *   - Symlinks are resolved before the check, so a symlink pointing out of
 *     the allowlist is rejected.
 *   - Hidden directories (`.git`, `.ssh`, etc.) inside an allowed root are
 *     NOT auto-rejected — they're inside an explicitly-granted root, so the
 *     user has already trusted the boundary. We do explicitly block reads
 *     of `/etc/shadow`-style absolute paths via the allowlist alone.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ToolContext } from '../core/types.js';

export interface ResolvedPath {
  /** The absolute, symlink-resolved path. */
  abs: string;
  /** The path the model supplied, for messages. */
  original: string;
}

export class PathOutsideAllowlistError extends Error {
  constructor(public abs: string, public allowed: string[]) {
    super(`Path is outside the allowlist: ${abs}\nAllowed roots: ${allowed.join(', ')}`);
    this.name = 'PathOutsideAllowlistError';
  }
}

/**
 * Resolve `input` to an absolute, allowlist-checked path. Throws on
 * traversal violations. `requireExists` decides whether to realpath (which
 * implicitly requires existence) or just normalise (for fs.write of a new
 * file inside an allowed dir).
 */
export async function resolvePath(
  input: string,
  ctx: ToolContext,
  requireExists: boolean,
): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const cwd = ctx.cwd ?? process.cwd();
  // Realpath-resolve the allowlist roots too — otherwise macOS's
  // /tmp → /private/tmp symlink (and similar) make the inside/outside check
  // compare apples to oranges. Roots that don't exist fall back to the
  // resolved literal so write-into-new-dir scenarios still work.
  const allowed: string[] = await Promise.all(
    (ctx.allowedPaths ?? [cwd]).map(async p => {
      const r = path.resolve(p);
      try { return await fs.realpath(r); } catch { return r; }
    })
  );
  const raw = path.resolve(cwd, input);

  let abs = raw;
  if (requireExists) {
    abs = await fs.realpath(raw);
  } else {
    const parent = path.dirname(raw);
    const leaf = path.basename(raw);
    let parentReal: string;
    try {
      parentReal = await fs.realpath(parent);
    } catch {
      parentReal = parent;
    }
    abs = path.join(parentReal, leaf);
  }

  const ok = allowed.some(root => abs === root || abs.startsWith(root + path.sep));
  if (!ok) {
    throw new PathOutsideAllowlistError(abs, allowed);
  }
  return { abs, original: input };
}
