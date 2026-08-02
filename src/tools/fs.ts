/**
 * fs.* tools — read, list, write.
 *
 * All paths go through resolvePath which enforces the run's allowlist
 * (defaults to cwd). Symlink escapes are blocked. Each tool ships with a
 * Zod schema so the loop validates args before dispatch.
 */
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef } from '../core/types.js';
import { resolvePath } from './path-guard.js';

const MAX_READ_BYTES = 1_000_000; // 1 MB cap on a single read
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 1000;

// ── fs.read ───────────────────────────────────────────────────────────────

const FsReadSchema = z.object({
  path: z.string().min(1),
  // Optional line range; 1-based inclusive. If both omitted, return whole file.
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** Treat content as text. Binary files are still read but base64-encoded. */
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});

export const fsReadTool: ToolDef = {
  name: 'fs.read',
  description: 'Read a file from the filesystem. Returns up to 1MB of content. Use startLine/endLine to fetch a slice. Paths are relative to the working directory.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to read, relative or absolute' },
      startLine: { type: 'number', description: '1-based line number to start at (inclusive)' },
      endLine: { type: 'number', description: '1-based line number to end at (inclusive)' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Encoding; defaults to utf8' },
    },
    required: ['path'],
  },
  paramsSchema: FsReadSchema,
  handler: async (raw, ctx) => {
    const args = FsReadSchema.parse(raw);
    const { abs } = await resolvePath(args.path, ctx, /*requireExists*/ true);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return `Error: ${args.path} is not a regular file`;
    if (stat.size > MAX_READ_BYTES && !args.startLine && !args.endLine) {
      return `Error: file is ${stat.size} bytes (>${MAX_READ_BYTES}). Read a slice using startLine/endLine.`;
    }

    if (args.encoding === 'base64') {
      const buf = await fs.readFile(abs);
      return buf.toString('base64');
    }
    const txt = await fs.readFile(abs, 'utf8');
    if (args.startLine || args.endLine) {
      const lines = txt.split('\n');
      const s = Math.max(1, args.startLine ?? 1);
      const e = Math.min(lines.length, args.endLine ?? lines.length);
      const slice = lines.slice(s - 1, e);
      // Prefix each line with its number so the model can reference it.
      return slice.map((l, i) => `${s + i}\t${l}`).join('\n');
    }
    return txt;
  },
};

// ── fs.list ───────────────────────────────────────────────────────────────

const FsListSchema = z.object({
  path: z.string().min(1).default('.'),
  /** When true, walk subdirectories (still capped at MAX_LIST_ENTRIES). */
  recursive: z.boolean().default(false),
  /** When true, include dot-prefixed entries; defaults to false. */
  includeHidden: z.boolean().default(false),
});

export const fsListTool: ToolDef = {
  name: 'fs.list',
  description: 'List entries in a directory. Returns up to 1000 entries with type (file/dir/link) and size. Set recursive=true to walk subtrees.',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list; defaults to "."' },
      recursive: { type: 'boolean', description: 'Walk subtrees; defaults to false' },
      includeHidden: { type: 'boolean', description: 'Include dot-files; defaults to false' },
    },
    required: [],
  },
  paramsSchema: FsListSchema,
  handler: async (raw, ctx) => {
    const args = FsListSchema.parse(raw);
    const { abs } = await resolvePath(args.path, ctx, /*requireExists*/ true);
    const out: string[] = [];
    let count = 0;
    const walk = async (dir: string, prefix: string) => {
      if (count >= MAX_LIST_ENTRIES) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        out.push(`${prefix} (error: ${e.message})`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= MAX_LIST_ENTRIES) break;
        if (!args.includeHidden && e.name.startsWith('.')) continue;
        const rel = path.join(prefix, e.name);
        let kind = 'file';
        if (e.isDirectory()) kind = 'dir';
        else if (e.isSymbolicLink()) kind = 'link';
        let size = '';
        if (e.isFile()) {
          try {
            const s = await fs.stat(path.join(dir, e.name));
            size = `\t${s.size}`;
          } catch { /* skip */ }
        }
        out.push(`${kind}\t${rel}${size}`);
        count++;
        if (args.recursive && e.isDirectory()) {
          await walk(path.join(dir, e.name), rel);
        }
      }
    };
    await walk(abs, args.path === '.' ? '' : args.path);
    if (count >= MAX_LIST_ENTRIES) out.push(`... (truncated at ${MAX_LIST_ENTRIES})`);
    return out.join('\n') || '(empty)';
  },
};

// ── fs.write ──────────────────────────────────────────────────────────────

const FsWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Append instead of overwrite. Defaults to false. */
  append: z.boolean().default(false),
  /** Create parent directories if missing. Defaults to false. */
  mkdirp: z.boolean().default(false),
});

export const fsWriteTool: ToolDef = {
  name: 'fs.write',
  description: 'Write content to a file. Overwrites by default; set append=true to append. Use mkdirp=true to create missing parent directories.',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      append: { type: 'boolean' },
      mkdirp: { type: 'boolean' },
    },
    required: ['path', 'content'],
  },
  paramsSchema: FsWriteSchema,
  handler: async (raw, ctx) => {
    const args = FsWriteSchema.parse(raw);
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      return `Error: content is ${bytes} bytes (>${MAX_WRITE_BYTES})`;
    }
    const { abs } = await resolvePath(args.path, ctx, /*requireExists*/ false);
    if (args.mkdirp) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
    }
    if (args.append) {
      await fs.appendFile(abs, args.content, 'utf8');
    } else {
      await fs.writeFile(abs, args.content, 'utf8');
    }
    return `wrote ${bytes} bytes to ${args.path}${args.append ? ' (appended)' : ''}`;
  },
};
