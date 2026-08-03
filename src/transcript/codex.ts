import type { SessionRecord } from '../persistence/session-store.js';
import { contentText } from './from-session.js';
import { redactTranscriptValue } from './redact.js';

export function codexEventsFromSession(record: SessionRecord): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { type: 'thread.started', thread_id: record.id },
  ];
  let turnOpen = false;
  let turnCount = 0;
  const pending = new Map<string, { name: string; arguments: Record<string, unknown> }>();

  const finishTurn = (final: boolean) => {
    if (!turnOpen) return;
    out.push({
      type: 'turn.completed',
      usage: {
        input_tokens: final ? record.usage.promptTokens : 0,
        cached_input_tokens: 0,
        output_tokens: final ? record.usage.completionTokens : 0,
        reasoning_output_tokens: 0,
      },
    });
    turnOpen = false;
  };

  const totalTurns = record.messages.filter(message => message.role === 'user').length;
  for (const message of record.messages) {
    if (message.role === 'user') {
      finishTurn(turnCount === totalTurns);
      turnCount++;
      turnOpen = true;
      out.push({ type: 'turn.started' });
      out.push({
        type: 'item.completed',
        item: { id: `user_${turnCount}`, type: 'user_message', text: contentText(message.content) },
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (!turnOpen) { turnOpen = true; out.push({ type: 'turn.started' }); }
      if (contentText(message.content)) {
        out.push({
          type: 'item.completed',
          item: { id: `agent_${out.length}`, type: 'agent_message', text: contentText(message.content) },
        });
      }
      for (const [index, call] of (message.toolCalls ?? []).entries()) {
        const id = call.id ?? `tool_${out.length}_${index}`;
        pending.set(id, { name: call.name, arguments: call.arguments });
        out.push({ type: 'item.started', item: codexToolItem(id, call.name, call.arguments, 'in_progress') });
      }
      continue;
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? pending.keys().next().value ?? `tool_${out.length}`;
      const call = pending.get(id) ?? { name: 'unknown', arguments: {} };
      pending.delete(id);
      const failed = /^error|^err:|permissiondenied|argumenterror/i.test(contentText(message.content));
      out.push({
        type: 'item.completed',
        item: codexToolItem(id, call.name, call.arguments, failed ? 'failed' : 'completed', contentText(message.content)),
      });
    }
  }
  finishTurn(true);
  return redactTranscriptValue(out) as Array<Record<string, unknown>>;
}

function codexToolItem(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'in_progress' | 'completed' | 'failed',
  result?: string,
): Record<string, unknown> {
  if (name === 'shell.exec') {
    return {
      id,
      type: 'command_execution',
      command: String(args.command ?? ''),
      ...(args.cwd ? { cwd: String(args.cwd) } : {}),
      status,
      ...(result !== undefined ? { aggregated_output: result } : {}),
    };
  }
  return {
    id,
    type: 'mcp_tool_call',
    server: 'koan',
    tool: name,
    arguments: args,
    status,
    ...(result !== undefined
      ? status === 'failed' ? { error: { message: result } } : { result: { content: result } }
      : {}),
  };
}
