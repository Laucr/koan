import type { RawMessage, ToolCallRequest } from '../core/types.js';
import type { SessionRecord } from '../persistence/session-store.js';
import { materializeTranscriptEvents, newTranscriptEvent, sessionStartedEvent } from './koan.js';
import type { KoanTranscriptEvent, NewTranscriptEvent } from './types.js';

export function transcriptFromSession(record: SessionRecord): KoanTranscriptEvent[] {
  const events: NewTranscriptEvent[] = [sessionStartedEvent(record)];
  let turnNumber = 0;
  let turnId: string | undefined;
  let pending = new Map<string, ToolCallRequest>();
  const turns = record.messages.filter(message => message.role === 'user').length;
  let completedTurns = 0;

  const closeTurn = () => {
    if (!turnId) return;
    completedTurns++;
    const finalTurn = completedTurns === turns;
    events.push(newTranscriptEvent('turn.completed', {
      reconstructed: true,
      usage: {
        prompt_tokens: finalTurn ? record.usage.promptTokens : 0,
        completion_tokens: finalTurn ? record.usage.completionTokens : 0,
      },
      rounds: finalTurn ? record.usage.rounds : 0,
      tool_calls: finalTurn ? record.usage.toolCalls : 0,
    }, { timestamp: record.updatedAt, turnId }));
    turnId = undefined;
    pending = new Map();
  };

  for (const message of record.messages) {
    if (message.role === 'user') {
      closeTurn();
      turnId = `turn_${++turnNumber}`;
      events.push(newTranscriptEvent('turn.started', { reconstructed: true }, {
        timestamp: turnNumber === 1 ? record.createdAt : record.updatedAt,
        turnId,
      }));
      events.push(messageEvent('message.user', message, record.updatedAt, turnId));
      continue;
    }
    if (!turnId) {
      turnId = `turn_${++turnNumber}`;
      events.push(newTranscriptEvent('turn.started', { reconstructed: true }, {
        timestamp: record.createdAt,
        turnId,
      }));
    }
    if (message.role === 'assistant') {
      events.push(messageEvent('message.assistant', message, record.updatedAt, turnId));
      for (const call of message.toolCalls ?? []) {
        const key = call.id ?? `${call.name}:${pending.size}`;
        pending.set(key, call);
        events.push(newTranscriptEvent('tool.started', {
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          reconstructed: true,
        }, { timestamp: record.updatedAt, turnId }));
      }
      continue;
    }
    if (message.role === 'tool') {
      const entry = [...pending.entries()].find(([key]) => key === message.toolCallId)
        ?? [...pending.entries()][0];
      const call = entry?.[1];
      if (entry) pending.delete(entry[0]);
      events.push(newTranscriptEvent('tool.completed', {
        call_id: message.toolCallId,
        name: call?.name ?? 'unknown',
        arguments: call?.arguments ?? {},
        content: message.content,
        status: /^error|^err:|permissiondenied|argumenterror/i.test(contentText(message.content)) ? 'failed' : 'completed',
        reconstructed: true,
      }, { timestamp: record.updatedAt, turnId }));
    }
  }
  closeTurn();
  events.push(newTranscriptEvent('session.closed', { reconstructed: true }, { timestamp: record.updatedAt }));
  return materializeTranscriptEvents(record.id, events);
}

function messageEvent(
  type: 'message.user' | 'message.assistant',
  message: RawMessage,
  timestamp: string,
  turnId: string,
): NewTranscriptEvent {
  return newTranscriptEvent(type, {
    content: message.content,
    ...(message.media?.length ? { media: message.media } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    reconstructed: true,
  }, { timestamp, turnId });
}

export function contentText(content: RawMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
