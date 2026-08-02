/**
 * Agent profiles — the unit of "agent personality".
 *
 * A profile is a YAML file with a small, opinionated schema. It bundles:
 *   - system prompt template
 *   - default model / provider
 *   - tool allowlist (subset of registered tool names)
 *   - default permissions (which capabilities are auto-granted)
 *   - default search gate
 *   - max rounds and other ReAct knobs
 *
 * Resolution precedence (later wins):
 *   1. The 'default' built-in
 *   2. ~/.config/koan/profiles/<name>.yaml      (user-installed)
 *   3. .koan.yaml in the current working directory  (project-level)
 *   4. CLI flag `--profile`                       (explicit override)
 *
 * Built-in profiles ship inline as objects (not YAML files) so a fresh
 * install works without writing anything to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { z } from 'zod';
import { ToolGateMode, type ToolPermission } from '../core/types.js';

export const ProfilePermissionSchema = z.enum(['read', 'write', 'shell', 'network']);

export const ProfileSchema = z.object({
  /** Display name; must match the file basename for user-installed profiles. */
  name: z.string().min(1),
  /** Short description, surfaced by `koan profile list`. */
  description: z.string().optional(),
  /** Model id. Overridden by --model. */
  model: z.string().optional(),
  /** Provider id. Overridden by --provider. */
  provider: z.enum(['openai', 'anthropic']).optional(),
  /** System prompt template; supports {{var}} interpolation by the loop's
   *  across-conversation memory pipeline. */
  systemPromptTemplate: z.string().optional(),
  /** Tool names this profile exposes. If omitted, the full default toolkit
   *  is used. Set to [] for a knowledge-only profile. */
  tools: z.array(z.string()).optional(),
  /** Permissions auto-granted for this profile. */
  permissions: z.array(ProfilePermissionSchema).default([]),
  /** Default search-gate mode. */
  defaultSearchGate: z.nativeEnum(ToolGateMode).optional(),
  /** Max ReAct rounds per turn. */
  maxRounds: z.number().int().positive().optional(),
  /**
   * Across-conversation user memory. Off by default — turn it on per
   * profile when the agent should learn standing facts about the user
   * across sessions. memory_mechanism.md §8: no production-safe default.
   */
  acrossConversationMemory: z.boolean().default(false),
}).strict();

export type Profile = z.infer<typeof ProfileSchema>;

// ── Built-in profiles ───────────────────────────────────────────────────

export const BUILTIN_PROFILES: Record<string, Profile> = {
  default: {
    name: 'default',
    description: 'Generalist agent. Read-only tools auto-approved; write and shell require explicit grant.',
    systemPromptTemplate: [
      'You are a helpful general-purpose agent with access to filesystem and web tools.',
      '',
      'Guidelines:',
      '- Investigate the working directory with fs.read / fs.list before reasoning about file contents.',
      '- Prefer reading actual data over guessing.',
      '- When you have a complete answer, call submit_final_answer.',
      '- If a tool returns an error, read it carefully and try a corrected call rather than retrying blindly.',
    ].join('\n'),
    permissions: ['read'],
    maxRounds: 12,
    acrossConversationMemory: false,
  },
  coding: {
    name: 'coding',
    description: 'Software engineering agent. Read + write + shell. Biased toward terminator submission and concise diffs.',
    systemPromptTemplate: [
      'You are a software engineering agent. You have read, write, and shell access to the working directory.',
      '',
      'Guidelines:',
      '- Investigate the codebase before changing it. Read related files and tests first.',
      '- Make small, surgical edits. Don\'t reformat unrelated code or rename symbols not in scope.',
      '- Run the project\'s test/build commands via shell.exec when relevant; treat their output as ground truth.',
      '- Never run destructive commands (the framework will refuse them anyway).',
      '- When done, call submit_final_answer with a terse summary of what changed and why.',
    ].join('\n'),
    permissions: ['read', 'write', 'shell'],
    maxRounds: 16,
    acrossConversationMemory: false,
  },
  research: {
    name: 'research',
    description: 'Research agent. Read + network. Biased toward citing sources.',
    systemPromptTemplate: [
      'You are a research agent. You can read the local filesystem and fetch URLs from the web.',
      '',
      'Guidelines:',
      '- Use web.fetch to gather primary sources before answering.',
      '- Always cite the URL(s) you actually retrieved content from.',
      '- If you can answer from local files or your own knowledge, say so explicitly.',
      '- Refuse to fabricate citations. If you didn\'t fetch a source, don\'t pretend you did.',
      '- When done, call submit_final_answer with the answer + a "Sources:" section listing the URLs.',
    ].join('\n'),
    permissions: ['read', 'network'],
    maxRounds: 16,
    acrossConversationMemory: false,
  },
  strict: {
    name: 'strict',
    description: 'Knowledge-only agent. No tools at all.',
    systemPromptTemplate: 'You are a helpful agent. Answer the user directly from your own knowledge. Do not call any tools.',
    tools: [],
    permissions: [],
    maxRounds: 4,
    acrossConversationMemory: false,
  },
};

// ── Resolution ──────────────────────────────────────────────────────────

export function defaultProfilesDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'koan', 'profiles');
}

export function defaultProjectProfilePath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.koan.yaml');
}

export interface ProfileResolution {
  name: string;
  source: 'flag' | 'env' | 'project-file' | 'user-file' | 'builtin';
  profile: Profile;
  /** Where the YAML was read from, if applicable. */
  filePath?: string;
}

export interface ResolveProfileOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Override profiles dir (tests). */
  profilesDir?: string;
}

/**
 * Resolve which profile applies to this run.
 *
 * The selection rule is:
 *   - explicit flag wins
 *   - else env (KOAN_PROFILE)
 *   - else .koan.yaml in cwd (treated as the chosen profile itself, name from `name:`)
 *   - else 'default' built-in
 *
 * For the flag/env paths, lookup order for the named profile is:
 *   user-file → built-in. If neither exists, throws.
 */
export function resolveProfile(opts: ResolveProfileOptions = {}): ProfileResolution {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const profilesDir = opts.profilesDir ?? defaultProfilesDir();

  // Highest precedence: explicit flag.
  const flagName = opts.flag ?? env.KOAN_PROFILE;
  if (flagName) {
    const source: 'flag' | 'env' = opts.flag ? 'flag' : 'env';
    const userFile = path.join(profilesDir, `${flagName}.yaml`);
    if (fs.existsSync(userFile)) {
      const p = readProfileFile(userFile);
      ensureNameMatches(p, flagName, userFile);
      return { name: p.name, source: source === 'flag' ? 'flag' : 'env', profile: p, filePath: userFile };
    }
    const builtin = BUILTIN_PROFILES[flagName];
    if (builtin) {
      return { name: builtin.name, source: source === 'flag' ? 'flag' : 'env', profile: builtin };
    }
    throw new Error(`Unknown profile "${flagName}". Available: ${listAvailableProfiles(profilesDir).join(', ')}`);
  }

  // Project-level .koan.yaml
  const projectPath = defaultProjectProfilePath(cwd);
  if (fs.existsSync(projectPath)) {
    const p = readProfileFile(projectPath);
    return { name: p.name, source: 'project-file', profile: p, filePath: projectPath };
  }

  // Default built-in.
  return { name: 'default', source: 'builtin', profile: BUILTIN_PROFILES.default };
}

export function readProfileFile(filePath: string): Profile {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e: any) {
    throw new Error(`Failed to parse ${filePath}: ${e.message}`);
  }
  if (parsed && typeof parsed === 'object' && !('name' in (parsed as any))) {
    // Allow filename to fill in the name if the file omitted it.
    (parsed as any).name = path.basename(filePath, path.extname(filePath));
  }
  try {
    return ProfileSchema.parse(parsed);
  } catch (e: any) {
    const issues = e?.issues
      ? e.issues.map((i: any) => `  ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n')
      : String(e?.message || e);
    throw new Error(`Invalid profile ${filePath}:\n${issues}`);
  }
}

function ensureNameMatches(p: Profile, expectedName: string, filePath: string): void {
  if (p.name !== expectedName) {
    throw new Error(
      `Profile name "${p.name}" in ${filePath} does not match the filename "${expectedName}". ` +
      `Rename either the file or the \`name:\` field.`
    );
  }
}

export function listAvailableProfiles(profilesDir: string = defaultProfilesDir()): string[] {
  const out = new Set<string>(Object.keys(BUILTIN_PROFILES));
  try {
    for (const f of fs.readdirSync(profilesDir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        out.add(path.basename(f, path.extname(f)));
      }
    }
  } catch { /* dir doesn't exist; that's fine */ }
  return [...out].sort();
}

/** Render a profile back to YAML for `profile show`. */
export function profileToYaml(p: Profile): string {
  return yaml.dump(p, { lineWidth: 100, noRefs: true });
}
