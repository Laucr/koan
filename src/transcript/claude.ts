import type { SessionRecord } from '../persistence/session-store.js';
import { contentText } from './from-session.js';
import { redactTranscriptValue } from './redact.js';

export function claudeEventsFromSession(record: SessionRecord): Array<Record<string, unknown>> {
  const tools = record.messages.flatMap(message => message.toolCalls ?? []).map(call => call.name);
  const out: Array<Record<string, unknown>> = [{
    type: 'system',
    subtype: 'init',
    session_id: record.id,
    cwd: record.cwd,
    model: record.model,
    tools: [...new Set(tools)],
  }];
  let lastAssistant = '';
  let turns = 0;
  const pending = new Map<string, string>();

  for (const message of record.messages) {
    if (message.role === 'user') {
      turns++;
      out.push(claudeMessage('user', record.id, [{ type: 'text', text: contentText(message.content) }]));
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const text = contentText(message.content);
      if (text) { blocks.push({ type: 'text', text }); lastAssistant = text; }
      for (const [index, call] of (message.toolCalls ?? []).entries()) {
        const id = call.id ?? `tool_${out.length}_${index}`;
        pending.set(id, call.name);
        blocks.push({ type: 'tool_use', id, name: call.name, input: call.arguments });
      }
      out.push(claudeMessage('assistant', record.id, blocks));
      continue;
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? pending.keys().next().value ?? `tool_${out.length}`;
      const text = contentText(message.content);
      const failed = /^error|^err:|permissiondenied|argumenterror/i.test(text);
      pending.delete(id);
      out.push(claudeMessage('user', record.id, [{
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(failed ? { is_error: true } : {}),
      }]));
    }
  }

  out.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: turns,
    result: lastAssistant,
    session_id: record.id,
    total_cost_usd: 0,
    usage: {
      input_tokens: record.usage.promptTokens,
      output_tokens: record.usage.completionTokens,
    },
  });
  return redactTranscriptValue(out) as Array<Record<string, unknown>>;
}

function claudeMessage(
  type: 'user' | 'assistant',
  sessionId: string,
  content: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { type, session_id: sessionId, message: { role: type, content } };
}
