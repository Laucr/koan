import type { RawMessage, ToolCallRequest, ToolPermission } from '../core/types.js';

export type KoanTranscriptEventType =
  | 'session.started'
  | 'turn.started'
  | 'message.user'
  | 'message.assistant'
  | 'tool.started'
  | 'tool.completed'
  | 'turn.completed'
  | 'turn.failed'
  | 'session.closed';

export interface KoanTranscriptEvent {
  schema_version: 1;
  timestamp: string;
  session_id: string;
  sequence: number;
  turn_id?: string;
  type: KoanTranscriptEventType;
  payload: Record<string, unknown>;
}

export type NewTranscriptEvent = Omit<
  KoanTranscriptEvent,
  'schema_version' | 'session_id' | 'sequence'
>;

export interface TranscriptSink {
  readonly sessionId: string;
  readonly path: string;
  append(events: NewTranscriptEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface SessionStartedPayload {
  profile: string;
  provider: string;
  model: string;
  cwd: string;
  permissions: ToolPermission[];
}

export interface TurnCompletedPayload {
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  rounds: number;
  tool_calls: number;
  termination_reason?: string;
}

export interface ReconstructedTurn {
  id: string;
  messages: RawMessage[];
}

export interface ToolPair {
  call: ToolCallRequest;
  result?: RawMessage;
}

export type TranscriptFormat = 'koan' | 'codex' | 'claude';
