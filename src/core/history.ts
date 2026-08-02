/**
 * History Processing — faithful to history_processing.md
 * One slice line (before most recent user), convert once, shared media counter,
 * truncation reserves slack, oldest-first with escape, hint nudge not rule.
 */
import {
  ConversationHistory, ProcessedMessage, RawMessage, MediaRef,
  CompactionStrategy,
} from './types.js';
import { countTokens, countMessageTokens } from '../utils/tokens.js';
import { deepCopy, shallowCopyArray } from '../utils/defensive.js';

/** System-prompt addendum for the text-tagged protocol. */
const TEXT_PROTOCOL_INSTRUCTIONS = [
  'This conversation uses text-tagged tool calls (no native function-calling API).',
  '',
  'When you want to call a tool, include exactly one or more <tool_call> tags',
  'inline in your reply. Each tag opens with `<tool_call name="<tool_name>" id="<unique_id>">`,',
  'contains the JSON arguments object as its body, and closes with `</tool_call>`.',
  'You may include explanatory text before or after the tags.',
  '',
  'Tool results from a previous turn appear in the user message as <tool_result id="..."> blocks',
  'matching the id you supplied. When you have a complete answer, reply with no <tool_call> tags.',
].join('\n');

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export interface HistoryConfig {
  tokenBudget: number;
  slackTokens: number;
  // for the two policies when current round over budget
  aggressiveTruncateUserHead: boolean; // vs keep head drop what doesn't fit
}

const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  tokenBudget: 120_000,
  slackTokens: 800,
  aggressiveTruncateUserHead: false,
};

export class HistoryProcessor {
  private config: HistoryConfig;
  private mediaCounter = { image: 0, video: 0, document: 0 };

  constructor(cfg?: Partial<HistoryConfig>) {
    this.config = { ...DEFAULT_HISTORY_CONFIG, ...cfg };
  }

  /** Called once at request start. Splits raw history at last user msg. */
  sliceHistory(rawMessages: RawMessage[]): { prefix: RawMessage[]; suffix: RawMessage[] } {
    // Find the last user message index (most recent user turn start)
    let lastUserIdx = -1;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) {
      // no user yet? everything is prefix? unusual
      return { prefix: [], suffix: rawMessages };
    }
    return {
      prefix: rawMessages.slice(0, lastUserIdx),
      suffix: rawMessages.slice(lastUserIdx),
    };
  }

  /**
   * Convert raw -> processed. Assigns stable media IDs, computes+ caches tokens.
   * One forward pass. Media IDs never reset.
   */
  convert(raw: RawMessage[], isSuffix: boolean): ProcessedMessage[] {
    return raw.map((m, idx) => {
      const processed: ProcessedMessage = {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        toolCalls: m.toolCalls ? deepCopy(m.toolCalls) : undefined,
        toolCallId: m.toolCallId,
        tokens: 0,
        isInSuffix: isSuffix,
        originalIndex: idx,
      };

      // Media: assign persistent IDs from shared counter (simplified; real would merge existing)
      if (m.media && m.media.length) {
        processed.media = m.media.map(ref => {
          const cat = ref.kind;
          const nextId = ++this.mediaCounter[cat];
          return { kind: ref.kind, id: nextId };
        });
      }

      processed.tokens = this.computeTokens(processed);
      return processed;
    });
  }

  private computeTokens(p: ProcessedMessage): number {
    let t = countTokens(p.content || '');
    if (p.toolCalls) {
      for (const tc of p.toolCalls) {
        t += countTokens(JSON.stringify(tc));
      }
    }
    // media overhead
    if (p.media) t += p.media.length * 20;
    return t + 4; // role overhead
  }

  /** Build initial history from raw conversation + in-flight suffix start */
  initHistory(raw: RawMessage[]): ConversationHistory {
    const { prefix: rawPrefix, suffix: rawSuffix } = this.sliceHistory(raw);

    // Convert prefix (settled) then suffix. Shared counter across.
    const convPrefix = this.convert(rawPrefix, false);
    const convSuffix = this.convert(rawSuffix, true);

    return {
      prefix: convPrefix,
      suffix: convSuffix,
      nextMediaId: { ...this.mediaCounter },
    };
  }

  /** Get all messages for model (prefix + current suffix). Used before truncate. */
  getFullForModel(hist: ConversationHistory): ProcessedMessage[] {
    return [...hist.prefix, ...hist.suffix];
  }

  /**
   * Truncation: subtracts system + active react + reply budget + slack.
   * Then evicts oldest first (from prefix then old suffix?).
   * Default: round-by-round from oldest.
   * When current alone over: branch on config.
   */
  truncate(
    hist: ConversationHistory,
    systemTokens: number,
    activeReactStackTokens: number,
    replyBudget: number
  ): { messages: ProcessedMessage[]; droppedCount: number; hintAppended: boolean } {
    const budget = this.config.tokenBudget - systemTokens - activeReactStackTokens - replyBudget - this.config.slackTokens;
    if (budget <= 0) {
      // extreme, keep minimal
      const last = hist.suffix[hist.suffix.length - 1];
      return { messages: last ? [last] : [], droppedCount: this.getFullForModel(hist).length - 1, hintAppended: true };
    }

    let working = this.getFullForModel(hist);
    let total = working.reduce((sum, m) => sum + m.tokens, 0);
    let dropped = 0;

    // Evict from oldest (front) until fits or only suffix left?
    while (total > budget && working.length > 0) {
      // Never drop the very last user/assistant turn aggressively unless policy
      const oldest = working[0];
      if (working.length === 1) break;

      // Conservative default: prefer to drop old prefix
      working.shift();
      total -= oldest.tokens;
      dropped++;
    }

    // If still over (current round's suffix alone too big)
    if (total > budget) {
      if (this.config.aggressiveTruncateUserHead) {
        // drop from head of the (last) user message content? Simplified: truncate its content
        const last = working[working.length - 1];
        if (last && last.role === 'user' && last.content.length > 100) {
          last.content = last.content.slice(0, Math.floor(last.content.length * 0.6)) + '… [truncated]';
          last.tokens = this.computeTokens(last);
        }
      } else {
        // keep head, drop what doesn't fit — already did shift, may leave partial
      }
    }

    // Recompute? The suffix part may have been mutated in place.
    // Re-split logically? For simplicity return working. Caller can re-bucket if needed.
    // But philosophy: split survives unchanged. We only mutate content for truncation.

    // Append hint if tight — only on the last user message and only once.
    let hintAppended = false;
    if (budget - total < 300 && working.length > 0) {
      const last = working[working.length - 1];
      if (last.role === 'user' && !(last as any)._hintAppended) {
        last.content = (last.content || '') + '\n\n[Hint: answer directly, do not keep calling tools if possible]';
        last.tokens = this.computeTokens(last);
        (last as any)._hintAppended = true;
        hintAppended = true;
      }
    }

    return { messages: working, droppedCount: dropped, hintAppended };
  }

  /**
   * Assemble final messages for the LLM request.
   *
   * Two protocol modes share this method (history_processing.md §4):
   *   - 'structured' (default): emit typed tool_calls + tool-role messages.
   *     Runs an extra invariant-enforcement pass: every tool message must
   *     follow an assistant message that requested it; orphans are dropped.
   *   - 'text': flatten tool calls and results into the assistant/user
   *     content as <tool_call>/<tool_result> tags. The text-protocol path
   *     skips the structured invariant pass — text consumers don't validate.
   */
  assembleForLLM(
    processed: ProcessedMessage[],
    systemPrompt: string,
    mode: 'structured' | 'text' = 'structured',
  ): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string }> {
    if (mode === 'text') return this.assembleForLLMText(processed, systemPrompt);
    return this.assembleForLLMStructured(processed, systemPrompt);
  }

  private assembleForLLMStructured(
    processed: ProcessedMessage[],
    systemPrompt: string,
  ): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string }> {
    const out: any[] = [{ role: 'system', content: systemPrompt }];

    // Invariant pass: track tool_call_ids the assistant has requested so we
    // can drop tool-role messages that don't match. Structured-API consumers
    // reject orphan tool messages; the text path doesn't need this.
    const openCallIds = new Set<string>();

    for (const m of processed) {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
        const calls = m.toolCalls.map((tc, i) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
        for (const c of calls) openCallIds.add(c.id);
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: calls,
        });
      } else if (m.role === 'tool') {
        const id = m.toolCallId || 'unknown';
        // Drop orphans — no preceding assistant claimed this id.
        if (id !== 'unknown' && !openCallIds.has(id)) continue;
        out.push({
          role: 'tool',
          tool_call_id: id,
          content: m.content || '',
        });
        openCallIds.delete(id);
      } else {
        out.push({ role: m.role, content: m.content || '' });
      }
    }
    return out;
  }

  /**
   * Text-tagged assembly. Tool calls become <tool_call name="..." id="..."> blocks
   * inside the assistant content; tool results become <tool_result id="..."> blocks
   * in the *next* user message (since text-only LLM APIs have no tool role).
   *
   * Format chosen to be unambiguous with no LLM-generated text that would
   * realistically collide with a literal `<tool_call ` opener.
   */
  private assembleForLLMText(
    processed: ProcessedMessage[],
    systemPrompt: string,
  ): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: any[]; tool_call_id?: string }> {
    const out: any[] = [{ role: 'system', content: systemPrompt + '\n\n' + TEXT_PROTOCOL_INSTRUCTIONS }];

    // Buffer tool results between assistant turns so they fold into a
    // single synthetic user message before the next real user/assistant.
    let pendingToolResults: string[] = [];
    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      out.push({ role: 'user', content: pendingToolResults.join('\n') });
      pendingToolResults = [];
    };

    for (const m of processed) {
      if (m.role === 'tool') {
        const id = m.toolCallId || 'unknown';
        const safe = String(m.content || '').replace(/<\/tool_result>/g, '<\\/tool_result>');
        pendingToolResults.push(`<tool_result id="${escapeAttr(id)}">${safe}</tool_result>`);
        continue;
      }
      // Drain pending tool results before the next user/assistant turn.
      flushToolResults();

      if (m.role === 'assistant') {
        let content = m.content || '';
        if (m.toolCalls && m.toolCalls.length) {
          for (const tc of m.toolCalls) {
            const id = tc.id || '';
            const args = JSON.stringify(tc.arguments ?? {});
            const safeArgs = args.replace(/<\/tool_call>/g, '<\\/tool_call>');
            content += `\n<tool_call name="${escapeAttr(tc.name)}" id="${escapeAttr(id)}">${safeArgs}</tool_call>`;
          }
        }
        out.push({ role: 'assistant', content: content || null });
      } else {
        out.push({ role: m.role, content: m.content || '' });
      }
    }
    flushToolResults();
    return out;
  }

  // For folding / compaction later.
  // NOTE: with `prefix_with_ref` the *recovery store* must be populated at
  // the same time as the ref is generated, so the actual fold lives in
  // `InConversationMemory` (which owns the store). This method handles only
  // the strategies that don't need a recovery side-channel.
  applyFoldStrategy(messages: ProcessedMessage[], strategy: CompactionStrategy, keepPrefixLen = 200): ProcessedMessage[] {
    if (strategy === CompactionStrategy.NONE) return messages;
    if (strategy === CompactionStrategy.PREFIX_WITH_REF) {
      throw new Error('prefix_with_ref must be folded by InConversationMemory (recovery store ownership)');
    }

    return messages.map((m) => {
      if (m.role !== 'tool') return m; // only fold tool results
      // Idempotency: never re-fold an already-folded message.
      if ((m as any)._folded) return m;

      const copy = { ...m };
      const origContent = m.content || '';

      switch (strategy) {
        case CompactionStrategy.REMOVE:
          copy.content = '';
          copy.tokens = 4;
          (copy as any)._folded = true;
          break;
        case CompactionStrategy.EMPTY:
          copy.content = '[tool result folded: empty]';
          copy.tokens = countTokens(copy.content) + 4;
          (copy as any)._folded = true;
          break;
        case CompactionStrategy.PREFIX:
          copy.content = origContent.slice(0, keepPrefixLen) + (origContent.length > keepPrefixLen ? '… [prefix only]' : '');
          copy.tokens = countTokens(copy.content) + 4;
          (copy as any)._folded = true;
          break;
        default:
          break;
      }
      return copy;
    });
  }
}
