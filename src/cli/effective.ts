/**
 * Effective run-config: combines a resolved profile with CLI flag overrides
 * into the concrete inputs runReActAgent needs.
 *
 * Profile defines the *baseline* (system prompt, tools, permissions, model,
 * maxRounds, search gate). Flags can:
 *   - widen permissions (--allow-write, --allow-shell, --allow-network)
 *   - widen path allowlist (--allow-path)
 *   - override model / provider / maxRounds
 *   - force --no-tools (knowledge-only)
 *
 * Flags cannot *narrow* a profile's permissions — that's the profile
 * designer's choice. (`strict` for knowledge-only.)
 *
 * --auto-approve safe|all adds permissions on top of the profile too:
 *   safe → adds 'network' if not already present
 *   all  → adds 'network', 'write', 'shell'
 *
 * The resulting permission set is what's handed to runReActAgent. The
 * TTY approver is still consulted per-call when --auto-approve is not 'all'.
 */
import { DEFAULT_TOOLKIT } from '../tools/index.js';
import type { Profile } from './profile.js';
import type { ToolPermission } from '../core/types.js';

export type ApproveMode = 'none' | 'safe' | 'all';

export interface ResolveEffectiveOptions {
  profile: Profile;
  approveMode: ApproveMode;
  allowWrite?: boolean;
  allowShell?: boolean;
  allowNetwork?: boolean;
  /** --no-tools force */
  noTools?: boolean;
  /** --max-rounds override */
  maxRoundsOverride?: number;
}

export interface EffectiveConfig {
  systemPrompt: string;
  toolNames: string[];
  permissions: Set<ToolPermission>;
  maxRounds: number;
}

const DEFAULT_TOOL_NAMES = DEFAULT_TOOLKIT.map(t => t.name);

export function buildEffectiveConfig(opts: ResolveEffectiveOptions): EffectiveConfig {
  const p = opts.profile;

  // Tools: profile.tools wins if defined; else the full default toolkit.
  // --no-tools forces []. The terminator submit_final_answer stays available
  // either way because the loop's effectiveTools list comes from the agent
  // config; profiles that want to exclude it must list explicit tools without it.
  let toolNames: string[];
  if (opts.noTools) {
    toolNames = [];
  } else if (p.tools !== undefined) {
    toolNames = [...p.tools];
  } else {
    toolNames = [...DEFAULT_TOOL_NAMES];
  }

  // Permissions: union of profile + approve-mode + per-flag grants.
  const permissions = new Set<ToolPermission>(p.permissions);
  if (opts.approveMode === 'safe' || opts.approveMode === 'all') permissions.add('network');
  if (opts.approveMode === 'all') { permissions.add('write'); permissions.add('shell'); }
  if (opts.allowWrite) permissions.add('write');
  if (opts.allowShell) permissions.add('shell');
  if (opts.allowNetwork) permissions.add('network');

  // System prompt: profile's template (rendered later for {{vars}} by the loop),
  // or a tiny fallback that respects the tools-on/off state.
  const systemPrompt = p.systemPromptTemplate
    ?? fallbackSystemPrompt(toolNames.length > 0);

  const maxRounds = opts.maxRoundsOverride ?? p.maxRounds ?? 12;

  return { systemPrompt, toolNames, permissions, maxRounds };
}

function fallbackSystemPrompt(hasTools: boolean): string {
  if (!hasTools) {
    return 'You are a helpful agent. Answer the user directly from your own knowledge. Do not call any tools.';
  }
  return 'You are a helpful general-purpose agent. Use tools when needed. When done, call submit_final_answer.';
}
