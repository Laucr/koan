/**
 * CLI config loader.
 *
 * Resolution order (later wins):
 *   1. ~/.config/koan/config.json   (user file)
 *   2. process.env                   (KOAN_*, OPENAI_API_KEY, ANTHROPIC_API_KEY)
 *   3. CLI flags                     (passed in by the caller)
 *
 * Secrets (API keys) live ONLY in env / CLI — never in the JSON file. We
 * actively reject `apiKey` keys in config.json to prevent accidental leakage
 * via dotfiles checked into git.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export const ProviderSchema = z.enum(['openai', 'anthropic']);
export type Provider = z.infer<typeof ProviderSchema>;

export const TranscriptFileConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().min(1).optional(),
}).strict();

export const FileConfigSchema = z.object({
  provider: ProviderSchema.default('openai'),
  model: z.string().default('gpt-4o-mini'),
  baseURL: z.string().url().optional(),
  llmTimeoutMs: z.number().int().positive().default(60_000),
  // Profile selection (used in M5; harmless to accept now).
  profile: z.string().optional(),
  transcripts: TranscriptFileConfigSchema.default({}),
}).strict()
  // Reject secret-bearing keys with a hint.
  .superRefine((v, ctx) => {
    for (const banned of ['apiKey', 'api_key', 'token', 'secret']) {
      if (banned in v) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Config file must not contain "${banned}". Put secrets in env vars instead.`,
        });
      }
    }
  });

export type FileConfig = z.infer<typeof FileConfigSchema>;

export interface CLIFlags {
  provider?: Provider;
  model?: string;
  baseURL?: string;
  llmTimeoutMs?: number;
  profile?: string;
  transcriptEnabled?: boolean;
  transcriptDirectory?: string;
}

export interface ResolvedTranscriptConfig {
  enabled: boolean;
  directory?: string;
}

export interface ResolvedConfig {
  provider: Provider;
  model: string;
  baseURL?: string;
  apiKey: string;
  llmTimeoutMs: number;
  profile?: string;
  transcripts: ResolvedTranscriptConfig;
  // For diagnostics: where each value came from.
  sources: {
    provider: 'default' | 'file' | 'env' | 'flag';
    model: 'default' | 'file' | 'env' | 'flag';
    apiKey: 'env' | 'flag';
  };
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'koan', 'config.json');
}

export function readFileConfig(filePath: string = defaultConfigPath()): FileConfig | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Failed to parse ${filePath}: ${e.message}`);
  }
  return FileConfigSchema.parse(parsed);
}

function parseEnvBoolean(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

export function resolveTranscriptConfig(opts?: {
  filePath?: string;
  flags?: Pick<CLIFlags, 'transcriptEnabled' | 'transcriptDirectory'>;
  env?: NodeJS.ProcessEnv;
}): ResolvedTranscriptConfig {
  const env = opts?.env ?? process.env;
  const flags = opts?.flags ?? {};
  const file = readFileConfig(opts?.filePath);
  return {
    enabled: flags.transcriptEnabled
      ?? parseEnvBoolean('KOAN_TRANSCRIPTS_ENABLED', env.KOAN_TRANSCRIPTS_ENABLED)
      ?? file?.transcripts.enabled
      ?? true,
    directory: flags.transcriptDirectory
      ?? env.KOAN_TRANSCRIPTS_DIR
      ?? file?.transcripts.directory
      ?? undefined,
  };
}

/** Merge file + env + flags into one config. Throws on missing API key. */
export function resolveConfig(opts?: {
  filePath?: string;
  flags?: CLIFlags;
  // injected for tests
  env?: NodeJS.ProcessEnv;
}): ResolvedConfig {
  const env = opts?.env ?? process.env;
  const flags = opts?.flags ?? {};
  const file = readFileConfig(opts?.filePath);

  // provider
  const provider: Provider =
    (flags.provider as Provider) ??
    (env.KOAN_PROVIDER as Provider | undefined) ??
    file?.provider ??
    'openai';
  const providerSource: ResolvedConfig['sources']['provider'] =
    flags.provider ? 'flag'
      : env.KOAN_PROVIDER ? 'env'
        : file?.provider ? 'file'
          : 'default';

  // model
  const model =
    flags.model ??
    env.KOAN_MODEL ??
    file?.model ??
    (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini');
  const modelSource: ResolvedConfig['sources']['model'] =
    flags.model ? 'flag'
      : env.KOAN_MODEL ? 'env'
        : file?.model ? 'file'
          : 'default';

  // baseURL
  const baseURL = flags.baseURL ?? env.KOAN_BASE_URL ?? file?.baseURL ?? undefined;

  // apiKey (secret — never from file)
  let apiKey: string | undefined;
  let apiKeySource: 'env' | 'flag' = 'env';
  if (env.KOAN_API_KEY) apiKey = env.KOAN_API_KEY;
  else if (provider === 'openai' && env.OPENAI_API_KEY) apiKey = env.OPENAI_API_KEY;
  else if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const expected = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(
      `Missing API key. Set ${expected} (or KOAN_API_KEY) in your environment.`
    );
  }

  // timeout
  const llmTimeoutMs =
    flags.llmTimeoutMs ??
    (env.KOAN_LLM_TIMEOUT_MS ? Number(env.KOAN_LLM_TIMEOUT_MS) : undefined) ??
    file?.llmTimeoutMs ??
    60_000;
  if (!Number.isFinite(llmTimeoutMs) || llmTimeoutMs <= 0) {
    throw new Error(`Invalid llmTimeoutMs: ${llmTimeoutMs}`);
  }

  // profile (optional)
  const profile =
    flags.profile ??
    env.KOAN_PROFILE ??
    file?.profile ??
    undefined;

  const transcripts = resolveTranscriptConfig({ filePath: opts?.filePath, flags, env });

  return {
    provider,
    model,
    baseURL,
    apiKey,
    llmTimeoutMs,
    profile,
    transcripts,
    sources: { provider: providerSource, model: modelSource, apiKey: apiKeySource },
  };
}
