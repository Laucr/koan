/**
 * OpenAI streaming LLM client.
 *
 * Translates OpenAI's chat-completions streaming format into the
 * provider-agnostic LLMStreamEvent taxonomy. Honours AbortSignal and
 * a per-call timeout.
 */
import OpenAI from 'openai';
import type { LLMRequest } from '../core/types.js';
import { type LLMStreamEvent, type LLMStreamingClient, StreamAccumulator } from '../core/streaming.js';

export interface OpenAIStreamingOptions {
  apiKey?: string;
  baseURL?: string;
  defaultTimeoutMs?: number;
}

export function createOpenAIStreamingClient(opts?: OpenAIStreamingOptions): LLMStreamingClient {
  const client = new OpenAI({
    apiKey: opts?.apiKey || process.env.OPENAI_API_KEY || 'sk-dummy',
    baseURL: opts?.baseURL,
  });
  const defaultTimeout = opts?.defaultTimeoutMs ?? 60_000;

  return async function* (req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const chatReq: any = {
      model: req.model,
      messages: req.messages,
      stream: true,
    };
    if (req.tools && req.tools.length) {
      chatReq.tools = req.tools;
      chatReq.tool_choice = req.tool_choice;
    }

    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(
      () => timeoutCtrl.abort(new Error(`LLM call timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const signal = composeSignals(req.signal, timeoutCtrl.signal);

    const acc = new StreamAccumulator();
    let usage: any = undefined;
    // We track which indexes have been "started" so we only emit one
    // tool_call_started per tool call.
    const startedIndexes = new Set<number>();
    // Snapshot of names per index so we can emit tool_call_complete cleanly.
    const indexNames = new Map<number, string>();
    const indexIds = new Map<number, string>();

    try {
      const stream = await client.chat.completions.create(chatReq as any, { signal });

      for await (const chunk of stream as any) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
          if (chunk.usage) usage = chunk.usage;
          continue;
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          acc.ingestText(delta.content);
          yield { type: 'text_delta', text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;
            const name = tcDelta.function?.name;
            const id = tcDelta.id;
            const argsDelta = tcDelta.function?.arguments;

            if (id) indexIds.set(idx, id);
            if (name) indexNames.set(idx, name);

            if (!startedIndexes.has(idx) && (name || id)) {
              startedIndexes.add(idx);
              acc.ingestToolCallStart(idx, name ?? indexNames.get(idx) ?? '', id ?? indexIds.get(idx));
              yield {
                type: 'tool_call_started',
                index: idx,
                id: id ?? indexIds.get(idx),
                name: name ?? indexNames.get(idx) ?? '',
              };
            }

            if (typeof argsDelta === 'string' && argsDelta.length > 0) {
              acc.ingestToolCallArgsDelta(idx, argsDelta);
              yield { type: 'tool_call_args_delta', index: idx, delta: argsDelta };
            }
          }
        }

        if (chunk.usage) usage = chunk.usage;
      }
    } catch (e: any) {
      yield { type: 'error', error: e instanceof Error ? e : new Error(String(e)) };
      return;
    } finally {
      clearTimeout(timer);
    }

    // Emit completes for any tool calls we saw.
    const completed = acc.build(usage ? {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
    } : undefined);
    for (const tc of completed.message.tool_calls ?? []) {
      // We don't know the index reliably here; iterate the started set in order.
    }
    // Emit one complete per started index (in order).
    const orderedIndexes = [...startedIndexes].sort((a, b) => a - b);
    for (const idx of orderedIndexes) {
      const tc = (completed.message.tool_calls ?? [])[orderedIndexes.indexOf(idx)];
      if (!tc) continue;
      yield {
        type: 'tool_call_complete',
        index: idx,
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      };
    }

    yield { type: 'done', response: completed };
  };
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
