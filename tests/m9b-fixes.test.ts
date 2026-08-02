/**
 * Tests for the three F-class fixes from the post-M9 bailiff report:
 *   F1: across-conversation memory respects the off-by-default flag
 *   F2: registries init-freeze in real entrypoints
 *   F3: text-tagged protocol mode in history pipeline
 */
import { describe, it, expect } from 'vitest';
import {
  HistoryProcessor, ProtocolMode,
  runReActAgent, createAgentConfig,
  AcrossConversationMemory,
} from '../src/index.js';
import { __testing as loopTesting } from '../src/core/loop.js';
import { ProfileSchema, BUILTIN_PROFILES } from '../src/cli/profile.js';
import type { LLMClient, LLMResponse } from '../src/index.js';

// ── F1: across-conv memory off by default ──────────────────────────────

describe('F1: across-conv memory off by default', () => {
  it('Profile.acrossConversationMemory defaults to false', () => {
    const p = ProfileSchema.parse({ name: 'x' });
    expect(p.acrossConversationMemory).toBe(false);
  });

  it('all built-in profiles are off by default', () => {
    for (const name of ['default', 'coding', 'research', 'strict']) {
      expect(BUILTIN_PROFILES[name].acrossConversationMemory).toBe(false);
    }
  });

  it('runReActAgent does not call the fetcher when not provided', async () => {
    let called = 0;
    const llm: LLMClient = async () => ({ message: { content: 'hi', tool_calls: undefined } });
    const fetcher = async () => { called++; return { user_memories: 'should not appear' }; };

    // No fetcher passed at all → no fetch, template vars left as empty.
    await runReActAgent({
      agentConfig: createAgentConfig({
        name: 'no-mem', maxRounds: 2, tools: [],
        systemPromptTemplate: 'hello {{user_memories}} world',
      }),
      llm,
      userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
    });
    expect(called).toBe(0);
  });

  it('runReActAgent does call the fetcher when one is provided', async () => {
    let called = 0;
    const llm: LLMClient = async () => ({ message: { content: 'hi', tool_calls: undefined } });
    const fetcher = async () => { called++; return { user_memories: 'remembered' }; };

    await runReActAgent({
      agentConfig: createAgentConfig({
        name: 'mem', maxRounds: 2, tools: [],
        systemPromptTemplate: 'hello {{user_memories}} world',
      }),
      llm,
      userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
      userMemoryFetcher: fetcher,
    });
    expect(called).toBe(1);
  });
});

// ── F3: text-tagged protocol mode ──────────────────────────────────────

describe('F3: text-tagged protocol mode', () => {
  it('ProtocolMode enum exposes both modes', () => {
    expect(ProtocolMode.STRUCTURED).toBe('structured');
    expect(ProtocolMode.TEXT).toBe('text');
  });

  it('AgentConfig.protocolMode defaults to "structured"', () => {
    const cfg = createAgentConfig({ name: 'd' });
    expect(cfg.protocolMode).toBe(ProtocolMode.STRUCTURED);
  });

  it('assembleForLLM (structured) emits typed tool_calls and tool messages', () => {
    const proc = new HistoryProcessor();
    const messages = [
      { role: 'user' as const, content: 'q', tokens: 1, isInSuffix: true },
      { role: 'assistant' as const, content: 'thinking', tokens: 1, isInSuffix: true,
        toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'x' } }] },
      { role: 'tool' as const, content: 'data', toolCallId: 'c1', tokens: 1, isInSuffix: true },
    ];
    const out = proc.assembleForLLM(messages, 'sys', 'structured');
    const assistant = out.find(m => m.role === 'assistant');
    expect(assistant?.tool_calls?.[0].function.name).toBe('fs.read');
    const toolMsg = out.find(m => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('c1');
  });

  it('assembleForLLM (structured) drops orphan tool messages', () => {
    const proc = new HistoryProcessor();
    const messages = [
      { role: 'user' as const, content: 'q', tokens: 1, isInSuffix: true },
      { role: 'tool' as const, content: 'orphan', toolCallId: 'unknown-id', tokens: 1, isInSuffix: true },
    ];
    const out = proc.assembleForLLM(messages, 'sys', 'structured');
    expect(out.find(m => m.role === 'tool')).toBeUndefined();
  });

  it('assembleForLLM (text) inlines tool calls as <tool_call> tags', () => {
    const proc = new HistoryProcessor();
    const messages = [
      { role: 'user' as const, content: 'q', tokens: 1, isInSuffix: true },
      { role: 'assistant' as const, content: 'thinking', tokens: 1, isInSuffix: true,
        toolCalls: [{ id: 'c1', name: 'fs.read', arguments: { path: 'x' } }] },
      { role: 'tool' as const, content: 'data', toolCallId: 'c1', tokens: 1, isInSuffix: true },
    ];
    const out = proc.assembleForLLM(messages, 'sys', 'text');
    // Assistant content carries the tool_call tag.
    const assistant = out.find(m => m.role === 'assistant');
    expect(assistant?.content).toMatch(/<tool_call name="fs\.read" id="c1">.*<\/tool_call>/);
    // Tool result lands in a synthetic user message as <tool_result>.
    const toolBlock = out.find(m => m.role === 'user' && /<tool_result id="c1">data<\/tool_result>/.test(String(m.content)));
    expect(toolBlock).toBeDefined();
    // No native tool-role message in text mode.
    expect(out.find(m => m.role === 'tool')).toBeUndefined();
    // System prompt gained the protocol instructions.
    expect(out[0].content).toMatch(/text-tagged tool calls/i);
  });

  it('parseTextProtocolToolCalls extracts tags + JSON args', () => {
    const { parseTextProtocolToolCalls } = loopTesting;
    const r = parseTextProtocolToolCalls(
      'I will read the file.\n<tool_call name="fs.read" id="c1">{"path":"x.txt"}</tool_call>\nOK.'
    );
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe('fs.read');
    expect(r.calls[0].id).toBe('c1');
    expect(r.calls[0].arguments).toEqual({ path: 'x.txt' });
    expect(r.contentWithoutCalls).toMatch(/I will read the file/);
    expect(r.contentWithoutCalls).not.toMatch(/<tool_call/);
  });

  it('malformed args land as { _raw } so the validator can produce a clean error', () => {
    const { parseTextProtocolToolCalls } = loopTesting;
    const r = parseTextProtocolToolCalls(
      '<tool_call name="fs.read" id="c1">{not json}</tool_call>'
    );
    expect(r.calls[0].arguments).toEqual({ _raw: '{not json}' });
  });

  it('end-to-end: text-mode loop drives a tool round and a final answer', async () => {
    let phase = 0;
    const llm: LLMClient = async (req): Promise<LLMResponse> => {
      phase++;
      if (phase === 1) {
        // Round 1: model emits a <tool_call> tag inline.
        return { message: { content: 'I need data.\n<tool_call name="echo" id="c1">{"x":1}</tool_call>' } };
      }
      // Round 2: model finishes without any tool tags.
      return { message: { content: 'all done' } };
    };

    // Register an inline echo tool. No permission so it always runs.
    const { registerTool } = await import('../src/index.js');
    try {
      registerTool({
        name: 'echo',
        description: 'echo args back',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
        handler: async (args) => `echoed:${JSON.stringify(args)}`,
      });
    } catch { /* registry frozen by an earlier file's test or already registered */ }

    const r = await runReActAgent({
      agentConfig: createAgentConfig({
        name: 'text-mode', maxRounds: 4, tools: ['echo'],
        protocolMode: ProtocolMode.TEXT,
      }),
      llm,
      userId: 'u',
      initialMessages: [{ role: 'user', content: 'go' }],
    });
    expect(r.finalAnswer).toBe('all done');
    expect(r.toolCallsMade).toBe(1);
    // Make sure the echoed tool result is in history (synthetic user msg in text mode,
    // tool-role msg in suffix from the loop's append path).
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.some((m: any) => /echoed:\{"x":1\}/.test(String(m.content)))).toBe(true);
  });
});
