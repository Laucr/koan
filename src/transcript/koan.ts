import type { SessionRecord } from '../persistence/session-store.js';
import type { KoanTranscriptEvent, NewTranscriptEvent, SessionStartedPayload } from './types.js';
import { redactTranscriptValue } from './redact.js';

export function newTranscriptEvent(
  type: NewTranscriptEvent['type'],
  payload: Record<string, unknown>,
  opts: { timestamp?: string; turnId?: string } = {},
): NewTranscriptEvent {
  return {
    type,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    ...(opts.turnId ? { turn_id: opts.turnId } : {}),
    payload,
  };
}

export function sessionStartedEvent(record: SessionRecord): NewTranscriptEvent {
  const payload: SessionStartedPayload = {
    profile: record.profile,
    provider: record.provider,
    model: record.model,
    cwd: record.cwd,
    permissions: record.permissions,
  };
  return newTranscriptEvent('session.started', payload as unknown as Record<string, unknown>, {
    timestamp: record.createdAt,
  });
}

export function materializeTranscriptEvents(
  sessionId: string,
  events: NewTranscriptEvent[],
): KoanTranscriptEvent[] {
  return events.map((event, index) => ({
    schema_version: 1,
    timestamp: event.timestamp,
    session_id: sessionId,
    sequence: index + 1,
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    type: event.type,
    payload: redactTranscriptValue(event.payload) as Record<string, unknown>,
  }));
}

export function encodeJsonl(records: unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
