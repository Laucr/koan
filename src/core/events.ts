import type { ToolCallRequest } from './types.js';

export type AgentLifecycleEvent =
  | {
    type: 'assistant_message';
    timestamp: string;
    round: number;
    content: string;
    toolCalls?: ToolCallRequest[];
  }
  | {
    type: 'tool_started';
    timestamp: string;
    round: number;
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
  }
  | {
    type: 'tool_completed';
    timestamp: string;
    round: number;
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
    content: string;
    error: boolean;
    durationMs: number;
  };

export type AgentLifecycleSubscriber = (event: AgentLifecycleEvent) => void;
