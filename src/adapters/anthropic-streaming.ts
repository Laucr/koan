/**
 * Anthropic streaming LLM client.
 * Translates Anthropic's SSE event taxonomy into LLMStreamEvent.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LLMRequest, LLMResponse } from '../core/types.js';
import { type LLMStreamEvent, type LLMStreamingClient, StreamAccumulator } from '../core/streaming.js';

export interface AnthropicStreamingOptions {
  apiKey?: string;
  baseURL?: string;
  defaultTimeoutMs?: number;
  defaultMaxTokens?: number;
}

export function createAnthropicStreamingClient(opts?: AnthropicStreamingOptions): LLMStreamingClient {
  const client = new Anthropic({
    apiKey: opts?.apiKey || process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy',
    baseURL: opts?.baseURL,
  });
  const defaultTimeout = opts?.defaultTimeoutMs ?? 60_000;
  const defaultMaxTokens = opts?.defaultMaxTokens ?? 4096;

  return async function* (req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const systemMsg = req.messages.find(m => m.role === 'system');
    const nonSystem = req.messages.filter(m => m.role !== 'system');
    const aMessages = nonSystem.map(m => convertMessage(m));
    const aTools = req.tools?.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    const aToolChoice = mapToolChoice(req.tool_choice);

    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(
      () => timeoutCtrl.abort(new Error(`LLM call timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const signal = composeSignals(req.signal, timeoutCtrl.signal);

    const acc = new StreamAccumulator();
    let promptTokens = 0;
    let completionTokens = 0;

    // Anthropic indexes content_blocks per block; tool_use blocks are
    // separate from text blocks. We map block index → tool-call index.
    const blockToToolIndex = new Map<number, number>();
    let nextToolIndex = 0;
    // Block-local tool metadata.
    const toolMeta = new Map<number, { id: string; name: string }>();

    try {
      const stream = (client as any).messages.stream(
        {
          model: req.model,
          max_tokens: defaultMaxTokens,
          system: systemMsg?.content ? String(systemMsg.content) : undefined,
          messages: aMessages,
          tools: aTools,
          tool_choice: aToolChoice,
        },
        { signal },
      );

      for await (const ev of stream as any) {
        switch (ev.type) {
          case 'content_block_start': {
            const block = ev.content_block;
            if (block?.type === 'tool_use') {
              const idx = nextToolIndex++;
              blockToToolIndex.set(ev.index, idx);
              toolMeta.set(idx, { id: block.id, name: block.name });
              acc.ingestToolCallStart(idx, block.name, block.id);
              yield { type: 'tool_call_started', index: idx, id: block.id, name: block.name };
            }
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (d?.type === 'text_delta' && typeof d.text === 'string') {
              acc.ingestText(d.text);
              yield { type: 'text_delta', text: d.text };
            } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const idx = blockToToolIndex.get(ev.index);
              if (idx !== undefined) {
                acc.ingestToolCallArgsDelta(idx, d.partial_json);
                yield { type: 'tool_call_args_delta', index: idx, delta: d.partial_json };
              }
            }
            break;
          }
          case 'message_delta': {
            if (ev.usage?.output_tokens) completionTokens = ev.usage.output_tokens;
            break;
          }
          case 'message_start': {
            if (ev.message?.usage?.input_tokens) promptTokens = ev.message.usage.input_tokens;
            break;
          }
          default:
            break;
        }
      }
    } catch (e: any) {
      yield { type: 'error', error: e instanceof Error ? e : new Error(String(e)) };
      return;
    } finally {
      clearTimeout(timer);
    }

    const usage: LLMResponse['usage'] | undefined =
      promptTokens || completionTokens
        ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
        : undefined;
    const response = acc.build(usage);

    // Emit per-tool completes in order.
    for (const tc of response.message.tool_calls ?? []) {
      // recover index from toolMeta by id
      let idx = -1;
      for (const [k, v] of toolMeta) if (v.id === tc.id) { idx = k; break; }
      yield {
        type: 'tool_call_complete',
        index: idx,
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      };
    }
    yield { type: 'done', response };
  };
}

function convertMessage(m: LLMRequest['messages'][number]): any {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }],
    };
  }
  if (m.role === 'assistant') {
    const content: any[] = [];
    if (m.content) content.push({ type: 'text', text: String(m.content) });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: any = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* leave */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
    }
    return { role: 'assistant', content };
  }
  return { role: 'user', content: String(m.content || '') };
}

function mapToolChoice(c: LLMRequest['tool_choice']) {
  if (!c || c === 'auto') return { type: 'auto' };
  if (c === 'none') return undefined;
  if (typeof c === 'object' && c.type === 'function') {
    return { type: 'tool', name: c.function.name };
  }
  return { type: 'auto' };
}

function composeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  a.addEventListener('abort', () => ctrl.abort(a.reason), { once: true });
  b.addEventListener('abort', () => ctrl.abort(b.reason), { once: true });
  return ctrl.signal;
}
