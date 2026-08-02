/**
 * OpenAI (and compatible) LLM client adapter.
 */
import OpenAI from 'openai';
import { LLMClient, LLMRequest, LLMResponse } from '../core/types.js';

export interface OpenAIClientOptions {
  apiKey?: string;
  baseURL?: string;
  /** Default per-call timeout if LLMRequest.timeoutMs is unset. */
  defaultTimeoutMs?: number;
}

export function createOpenAIClient(opts?: OpenAIClientOptions): LLMClient {
  const client = new OpenAI({
    apiKey: opts?.apiKey || process.env.OPENAI_API_KEY || 'sk-dummy',
    baseURL: opts?.baseURL,
  });
  const defaultTimeout = opts?.defaultTimeoutMs ?? 60_000;

  return async (req: LLMRequest): Promise<LLMResponse> => {
    const chatReq: any = {
      model: req.model,
      messages: req.messages,
    };
    if (req.tools && req.tools.length) {
      chatReq.tools = req.tools;
      chatReq.tool_choice = req.tool_choice;
    }

    // Compose the caller's signal with a fresh timeout signal so the SDK
    // call aborts on whichever fires first.
    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
    const signal = composeSignals(req.signal, timeoutCtrl.signal);

    let resp;
    try {
      resp = await client.chat.completions.create(chatReq as any, { signal });
    } finally {
      clearTimeout(timer);
    }
    const choice = resp.choices?.[0];
    const msg = choice?.message;

    return {
      message: {
        content: msg?.content ?? null,
        tool_calls: msg?.tool_calls?.map((tc: any) => ({
          id: tc.id,
          function: { name: tc.function?.name, arguments: tc.function?.arguments },
        })),
      },
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
      } : undefined,
    };
  };
}

/** Merge two AbortSignals into one that fires when either fires. */
function composeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return ctrl.signal;
}
