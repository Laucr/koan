/**
 * Contract tests for M1 (CLI binary, abort, timeout, config) and M2 (streaming).
 */
import { describe, it, expect } from 'vitest';
import { resolveConfig, FileConfigSchema } from '../src/cli/config.js';
import { parseArgv, flagAsString, flagAsBool, flagAsNumber } from '../src/cli/argv.js';
import { serveLLMFlags } from '../src/cli/serve-subcommand.js';
import { StreamAccumulator, type LLMStreamEvent, type LLMStreamingClient } from '../src/index.js';
import { runReActAgent, createAgentConfig, TerminationReason } from '../src/index.js';
import type { LLMRequest, LLMResponse, LLMClient } from '../src/index.js';

// ── argv ────────────────────────────────────────────────────────────────

describe('argv parser', () => {
  it('parses positional + --flag value + --flag=value + boolean', () => {
    const p = parseArgv(['run', 'hello world', '--model', 'gpt-x', '--timeout=300', '--no-stream']);
    expect(p.positional).toEqual(['run', 'hello world']);
    expect(flagAsString(p, 'model')).toBe('gpt-x');
    expect(flagAsNumber(p, 'timeout')).toBe(300);
    expect(flagAsBool(p, 'no-stream')).toBe(true);
  });
  it('-- terminates flag parsing', () => {
    const p = parseArgv(['--model', 'x', '--', '--not-a-flag']);
    expect(p.positional).toEqual(['--not-a-flag']);
    expect(flagAsString(p, 'model')).toBe('x');
  });
});

// ── config resolution ──────────────────────────────────────────────────

describe('resolveConfig', () => {
  it('errors if no API key is in env', () => {
    expect(() => resolveConfig({ env: {} })).toThrow(/Missing API key/);
  });
  it('flags override env, env overrides default', () => {
    const r = resolveConfig({
      env: {
        OPENAI_API_KEY: 'sk',
        KOAN_MODEL: 'env-model',
        KOAN_BASE_URL: 'http://env.example/v1',
      },
      flags: { model: 'flag-model', baseURL: 'http://flag.example/v1' },
    });
    expect(r.model).toBe('flag-model');
    expect(r.baseURL).toBe('http://flag.example/v1');
    expect(r.sources.model).toBe('flag');
    expect(r.apiKey).toBe('sk');
  });
  it('picks anthropic api key when provider is anthropic', () => {
    const r = resolveConfig({
      env: { ANTHROPIC_API_KEY: 'sk-ant' },
      flags: { provider: 'anthropic' },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBe('sk-ant');
    expect(r.model).toMatch(/claude/i); // anthropic default model
  });
  it('rejects API keys in the file config (security)', () => {
    expect(() => FileConfigSchema.parse({ apiKey: 'sk' })).toThrow();
    expect(() => FileConfigSchema.parse({ token: 'x' })).toThrow();
    expect(() => FileConfigSchema.parse({ provider: 'openai' })).not.toThrow();
  });
});

describe('serve LLM flags', () => {
  it('maps --base-url and related arguments into provider config', () => {
    const parsed = parseArgv([
      '--provider', 'openai',
      '--model', 'gpt-mock',
      '--base-url', 'http://127.0.0.1:8000/v1',
      '--timeout', '15000',
    ]);

    expect(serveLLMFlags(parsed)).toEqual({
      provider: 'openai',
      model: 'gpt-mock',
      baseURL: 'http://127.0.0.1:8000/v1',
      llmTimeoutMs: 15000,
    });
  });
});

// ── abort ──────────────────────────────────────────────────────────────

describe('runReActAgent abort', () => {
  it('aborts cleanly when signal fires before round 1', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('test'));
    const cfg = createAgentConfig({ name: 'a', maxRounds: 5, tools: [] });
    const llm: LLMClient = async () => ({ message: { content: 'ok' } });
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
      signal: ctrl.signal,
    });
    expect(r.warnings.some(w => /aborted/i.test(w))).toBe(true);
    expect(r.rounds).toBe(0);
  });

  it('aborts mid-flight if the LLM call rejects with abort error', async () => {
    const cfg = createAgentConfig({ name: 'a', maxRounds: 5, tools: [] });
    const ctrl = new AbortController();
    const llm: LLMClient = async (req) => {
      // Simulate a long call that's aborted.
      ctrl.abort(new Error('user pressed Ctrl-C'));
      throw new Error('AbortError: aborted');
    };
    const r = await runReActAgent({
      agentConfig: cfg, llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
      signal: ctrl.signal,
    });
    expect(r.warnings.some(w => /aborted/i.test(w))).toBe(true);
  });
});

describe('runReActAgent: requires either llm or streamLLM', () => {
  it('throws when neither is provided', async () => {
    const cfg = createAgentConfig({ name: 'a', maxRounds: 1, tools: [] });
    const r = await runReActAgent({
      agentConfig: cfg, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
    });
    // Loop swallows the throw and reports it as a round-budget warning.
    expect(r.warnings.some(w => /must provide/i.test(w))).toBe(true);
  });
});

// ── streaming ──────────────────────────────────────────────────────────

describe('StreamAccumulator', () => {
  it('assembles text + tool calls in index order', () => {
    const a = new StreamAccumulator();
    a.ingestText('Hello, ');
    a.ingestText('world');
    a.ingestToolCallStart(0, 'foo', 'id-foo');
    a.ingestToolCallArgsDelta(0, '{"q":');
    a.ingestToolCallArgsDelta(0, '"x"}');
    a.ingestToolCallStart(1, 'bar', 'id-bar');
    a.ingestToolCallArgsDelta(1, '{}');
    const built = a.build();
    expect(built.message.content).toBe('Hello, world');
    expect(built.message.tool_calls).toEqual([
      { id: 'id-foo', function: { name: 'foo', arguments: '{"q":"x"}' } },
      { id: 'id-bar', function: { name: 'bar', arguments: '{}' } },
    ]);
  });
});

describe('runReActAgent streaming path', () => {
  it('forwards events to onStreamEvent and assembles final response from `done`', async () => {
    const events: LLMStreamEvent[] = [];

    // A scripted streaming client: round 1 emits a few text chunks then done with no tool calls.
    const streamLLM: LLMStreamingClient = async function* (req) {
      yield { type: 'text_delta', text: 'Hello ' };
      yield { type: 'text_delta', text: 'from ' };
      yield { type: 'text_delta', text: 'stream' };
      const response: LLMResponse = {
        message: { content: 'Hello from stream', tool_calls: undefined },
      };
      yield { type: 'done', response };
    };

    const cfg = createAgentConfig({ name: 'a', maxRounds: 3, tools: [] });
    const r = await runReActAgent({
      agentConfig: cfg,
      streamLLM,
      onStreamEvent: (e) => { events.push(e); },
      userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
    });

    expect(r.termination).toBe(TerminationReason.NO_TOOL_CALLS);
    expect(r.finalAnswer).toBe('Hello from stream');
    // Consumer saw three text_deltas and one done.
    expect(events.filter(e => e.type === 'text_delta').length).toBe(3);
    expect(events.filter(e => e.type === 'done').length).toBe(1);
  });

  it('error events surface as a thrown failure', async () => {
    const streamLLM: LLMStreamingClient = async function* () {
      yield { type: 'text_delta', text: 'partial' };
      yield { type: 'error', error: new Error('boom') };
    };
    const cfg = createAgentConfig({ name: 'a', maxRounds: 3, tools: [] });
    const r = await runReActAgent({
      agentConfig: cfg, streamLLM, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
    });
    expect(r.warnings.some(w => /boom/i.test(w))).toBe(true);
  });

  it('a streaming round with tool_call events still drives the loop correctly', async () => {
    // Round 1: model wants a tool call. Round 2: model says done.
    let round = 0;
    const streamLLM: LLMStreamingClient = async function* (req) {
      round++;
      if (round === 1) {
        yield { type: 'text_delta', text: 'thinking...' };
        yield { type: 'tool_call_started', index: 0, id: 'c1', name: 'fake_tool' };
        yield { type: 'tool_call_args_delta', index: 0, delta: '{"x":1}' };
        const response: LLMResponse = {
          message: {
            content: 'thinking...',
            tool_calls: [{ id: 'c1', function: { name: 'fake_tool', arguments: '{"x":1}' } }],
          },
        };
        yield { type: 'tool_call_complete', index: 0, id: 'c1', name: 'fake_tool', argumentsJson: '{"x":1}' };
        yield { type: 'done', response };
      } else {
        const response: LLMResponse = { message: { content: 'all done', tool_calls: undefined } };
        yield { type: 'text_delta', text: 'all done' };
        yield { type: 'done', response };
      }
    };
    const cfg = createAgentConfig({ name: 'a', maxRounds: 5, tools: [] });
    const r = await runReActAgent({
      agentConfig: cfg, streamLLM, userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
    });
    // The fake_tool isn't registered, so it returns "Unknown tool" and the
    // model still gets a chance to terminate next round.
    expect(r.termination).toBe(TerminationReason.NO_TOOL_CALLS);
    expect(r.finalAnswer).toBe('all done');
    expect(r.toolCallsMade).toBe(1);
  });
});
