import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../src/persistence/session-store.js';
import {
  claudeEventsFromSession, codexEventsFromSession, exportSessionJsonl,
  transcriptFromSession,
} from '../src/transcript/index.js';

const record: SessionRecord = {
  id: 's_compat',
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:01.000Z',
  profile: 'coding',
  provider: 'openai',
  model: 'mock',
  cwd: '/workspace',
  permissions: ['read', 'shell'],
  usage: { promptTokens: 10, completionTokens: 4, toolCalls: 1, rounds: 2 },
  messages: [
    { role: 'user', content: 'where am I?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'shell.exec', arguments: { command: 'pwd', api_key: 'secret' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'exit=0\n/workspace' },
    { role: 'assistant', content: 'You are in /workspace.' },
  ],
};

describe('portable transcript projections', () => {
  it('reconstructs a complete canonical event sequence', () => {
    const events = transcriptFromSession(record);
    expect(events[0].type).toBe('session.started');
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.some(event => event.type === 'tool.started')).toBe(true);
    expect(events.some(event => event.type === 'tool.completed')).toBe(true);
  });

  it('emits documented Codex lifecycle and command item shapes', () => {
    const events = codexEventsFromSession(record);
    expect(events[0]).toEqual({ type: 'thread.started', thread_id: 's_compat' });
    expect(events.some(event => event.type === 'turn.started')).toBe(true);
    const command = events.find(event => (event.item as any)?.type === 'command_execution');
    expect(command).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('falls arbitrary tools back to a Koan MCP item', () => {
    const arbitrary: SessionRecord = {
      ...record,
      messages: [
        { role: 'user', content: 'read' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'fs.read', arguments: { path: 'a' } }] },
        { role: 'tool', toolCallId: 'x', content: 'ok' },
      ],
    };
    const item = codexEventsFromSession(arbitrary).find(event => (event.item as any)?.type === 'mcp_tool_call');
    expect(item?.item).toMatchObject({ server: 'koan', tool: 'fs.read' });
  });

  it('emits Claude init/messages/tool blocks/result', () => {
    const events = claudeEventsFromSession(record);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 's_compat' });
    expect(events.some(event => (event.message as any)?.content?.some((block: any) => block.type === 'tool_use'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', subtype: 'success', num_turns: 1 });
  });

  it('writes independently parseable JSONL for every format', () => {
    for (const format of ['koan', 'codex', 'claude'] as const) {
      const lines = exportSessionJsonl(record, format).trim().split('\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
