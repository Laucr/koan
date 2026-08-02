/**
 * Tool-vs-LLM Decision (tool_vs_llm_decision.md)
 * Constrain don't decide. Three modes. Multi-layer enforcement.
 * Search gate is first-class. One-shot force vs session-wide forbid.
 * Model sees consequences, never the mode label.
 */
import { ToolGateMode, ToolClass, ToolDef, LLMRequest, AgentConfig } from './types.js';

export interface GateDecision {
  mode: ToolGateMode;
  // for force, which tool(s)
  forcedToolNames?: string[];
}

// Words that imply searchability — stripped from the user message tail when
// the gate is in FORBID mode (5th enforcement layer; tool_vs_llm_decision.md §5).
// Case-insensitive, whole-word.
const SEARCH_HOTWORDS = [
  'search', 'google', 'bing', 'baidu', 'lookup', 'look up', 'browse', 'web',
  'online', 'internet', 'check the web',
];

export class ToolGate {
  private searchDecision: GateDecision = { mode: 'auto' };

  constructor(initial?: Partial<{ search: ToolGateMode }>) {
    if (initial?.search) {
      this.searchDecision = { mode: initial.search };
      // oneShot semantics handled at request time / state
    }
  }

  /** Merge signals at request time into pre-decided state. */
  setSearchGate(mode: ToolGateMode, oneShot = false) {
    this.searchDecision = { mode, forcedToolNames: mode === 'force' ? [] : undefined };
  }

  getSearchGate(): GateDecision {
    return { ...this.searchDecision };
  }

  /**
   * Shape the LLM request payload according to gate.
   * Multi layers:
   * - filter tools list                 (1)
   * - set tool_choice                   (2)
   * - caller is responsible for SP branch + directive in user tail (3, 4)
   * - hotword strip from user tail      (5) — see stripHotwords()
   */
  applyToLLMRequest(
    req: LLMRequest,
    allTools: ToolDef[],
    searchGate: GateDecision
  ): { modifiedTools: ToolDef[]; tool_choice?: LLMRequest['tool_choice']; note?: string } {
    let tools = [...allTools];
    let tool_choice: LLMRequest['tool_choice'] = 'auto';
    let note = '';

    const searchTools = tools.filter(t => t.toolClass === 'search');

    if (searchGate.mode === 'forbid') {
      tools = tools.filter(t => t.toolClass !== 'search');
      tool_choice = 'none';
      note = 'search forbidden by gate (removed + tool_choice=none)';
    } else if (searchGate.mode === 'force') {
      // Pin to search if any, or first available search-class
      if (searchTools.length > 0) {
        const target = searchGate.forcedToolNames?.[0] || searchTools[0].name;
        tool_choice = { type: 'function', function: { name: target } };
        note = `force search via tool_choice=${target}`;
      }
    } else {
      // auto: leave as is
    }

    return { modifiedTools: tools, tool_choice, note };
  }

  /**
   * For SP: caller can branch on gate to render "do not search" or "you must search first"
   */
  getSystemPromptDirective(gate: GateDecision): string {
    if (gate.mode === 'forbid') return 'You must NOT use search tools in this session. Rely on your knowledge or other available tools.';
    if (gate.mode === 'force') return 'You must begin by using a search tool to gather information.';
    return '';
  }

  /**
   * Splice into last user message (recency).
   */
  getUserTailDirective(gate: GateDecision): string {
    if (gate.mode === 'forbid') return '\n\nIMPORTANT: Do not perform any searches.';
    if (gate.mode === 'force') return '\n\nYou need to search now.';
    return '';
  }

  /**
   * 5th enforcement layer: remove search-implying hotwords from the user
   * message text when the gate is in FORBID mode. Removes the affordance
   * even from the model's *consideration*. (tool_vs_llm_decision.md §5)
   *
   * Pure function, returns the modified text. Idempotent.
   */
  stripHotwords(text: string, gate: GateDecision): string {
    if (gate.mode !== 'forbid' || !text) return text;
    let out = text;
    for (const word of SEARCH_HOTWORDS) {
      // word-boundary match, case-insensitive; replace with neutral verb
      const re = new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'gi');
      out = out.replace(re, '');
    }
    // collapse double spaces left behind
    out = out.replace(/[ \t]{2,}/g, ' ');
    return out;
  }
}
