/**
 * Anthropic LLM client adapter.
 * Maps the OpenAI-shaped LLMRequest/LLMResponse used by the rest of the
 * framework into Anthropic's messages.create API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LLMClient, LLMRequest, LLMResponse } from '../core/types.js';

export interface AnthropicClientOptions {
  apiKey?: string;
  baseURL?: string;
  defaultTimeoutMs?: number;
  /** Default max_tokens for the reply; Anthropic requires it. */
  defaultMaxTokens?: number;
}

export function createAnthropicClient(opts?: AnthropicClientOptions): LLMClient {
  const client = new Anthropic({
    apiKey: opts?.apiKey || process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy',
    baseURL: opts?.baseURL,
  });
  const defaultTimeout = opts?.defaultTimeoutMs ?? 60_000;
  const defaultMaxTokens = opts?.defaultMaxTokens ?? 4096;

  return async (req: LLMRequest): Promise<LLMResponse> => {
    // Pull out the system prompt — Anthropic takes it as a top-level field,
    // not as a message.
    const systemMsg = req.messages.find(m => m.role === 'system');
    const nonSystem = req.messages.filter(m => m.role !== 'system');

    // Convert framework messages → Anthropic content blocks.
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

    let resp: any;
    try {
      resp = await client.messages.create(
        {
          model: req.model,
          max_tokens: defaultMaxTokens,
          system: systemMsg?.content ? String(systemMsg.content) : undefined,
          messages: aMessages as any,
          tools: aTools as any,
          tool_choice: aToolChoice as any,
        },
        { signal },
      );
    } finally {
      clearTimeout(timer);
    }

    // Reassemble OpenAI-shaped response.
    let text = '';
    const toolCalls: NonNullable<LLMResponse['message']['tool_calls']> = [];
    for (const block of resp.content || []) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    return {
      message: {
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      usage: resp.usage ? {
        prompt_tokens: resp.usage.input_tokens,
        completion_tokens: resp.usage.output_tokens,
      } : undefined,
    };
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
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* leave as {} */ }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input,
        });
      }
    }
    return { role: 'assistant', content };
  }
  // user / system (system handled separately)
  return { role: 'user', content: String(m.content || '') };
}

function mapToolChoice(c: LLMRequest['tool_choice']) {
  if (!c || c === 'auto') return { type: 'auto' };
  if (c === 'none') return undefined; // Anthropic represents "none" by omitting tools; but we still pass tools, so leave auto with no required call. Caller should drop tools when forbidding.
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
