/**
 * Streaming LLM client interface (M2).
 *
 * The non-streaming `LLMClient` returns the full message at once; the
 * streaming variant yields events as they arrive. The framework supports
 * both — adapters implement either or both, and the harness picks based
 * on what the caller passed in.
 *
 * Events are intentionally provider-agnostic. Each adapter is responsible
 * for translating its native stream into this taxonomy.
 */
import type { LLMRequest, LLMResponse } from './types.js';

export type LLMStreamEvent =
  // Text chunk for the assistant message body.
  | { type: 'text_delta'; text: string }
  // Model has begun a tool call. `index` lets the consumer differentiate
  // parallel tool calls in the same assistant turn.
  | { type: 'tool_call_started'; index: number; id?: string; name: string }
  // Argument JSON delta for a tool call. Partial JSON is fine; consumers
  // accumulate until tool_call_complete.
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  // Tool call fully assembled (id, name, parsed args available via accumulation).
  | { type: 'tool_call_complete'; index: number; id?: string; name: string; argumentsJson: string }
  // Stream finished. The full assembled LLMResponse is provided so consumers
  // that want it (the loop) don't have to reassemble themselves.
  | { type: 'done'; response: LLMResponse }
  // Error from the underlying provider. After this, no further events.
  | { type: 'error'; error: Error };

export type LLMStreamingClient = (req: LLMRequest) => AsyncIterable<LLMStreamEvent>;

/**
 * Adapter helper: assemble a full LLMResponse from a stream by accumulating
 * deltas. Used by the loop to produce the same shape it'd get from a
 * non-streaming call. Adapters can also build the final response themselves
 * and emit it directly via `done`.
 */
export class StreamAccumulator {
  private text = '';
  private toolCalls = new Map<number, { id?: string; name?: string; args: string }>();

  ingestText(delta: string): void {
    this.text += delta;
  }

  ingestToolCallStart(index: number, name: string, id?: string): void {
    const existing = this.toolCalls.get(index) ?? { args: '' };
    existing.id = id ?? existing.id;
    existing.name = name;
    this.toolCalls.set(index, existing);
  }

  ingestToolCallArgsDelta(index: number, delta: string): void {
    const existing = this.toolCalls.get(index) ?? { args: '' };
    existing.args += delta;
    this.toolCalls.set(index, existing);
  }

  build(usage?: LLMResponse['usage']): LLMResponse {
    const toolCalls = Array.from(this.toolCalls.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        function: { name: v.name ?? '', arguments: v.args || '{}' },
      }));
    return {
      message: {
        content: this.text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      usage,
    };
  }

  getText(): string { return this.text; }
}
