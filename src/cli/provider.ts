/**
 * Provider factory: turns a ResolvedConfig into an LLMClient and (in M2)
 * an LLMStreamingClient. This is the seam the CLI and HTTP server share.
 */
import type { LLMClient } from '../core/types.js';
import type { LLMStreamingClient } from '../core/streaming.js';
import { createOpenAIClient } from '../adapters/openai.js';
import { createAnthropicClient } from '../adapters/anthropic.js';
import { createOpenAIStreamingClient } from '../adapters/openai-streaming.js';
import { createAnthropicStreamingClient } from '../adapters/anthropic-streaming.js';
import type { ResolvedConfig } from './config.js';

export function buildLLMClient(cfg: ResolvedConfig): LLMClient {
  if (cfg.provider === 'anthropic') {
    return createAnthropicClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      defaultTimeoutMs: cfg.llmTimeoutMs,
    });
  }
  return createOpenAIClient({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    defaultTimeoutMs: cfg.llmTimeoutMs,
  });
}

export function buildStreamingLLMClient(cfg: ResolvedConfig): LLMStreamingClient {
  if (cfg.provider === 'anthropic') {
    return createAnthropicStreamingClient({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      defaultTimeoutMs: cfg.llmTimeoutMs,
    });
  }
  return createOpenAIStreamingClient({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    defaultTimeoutMs: cfg.llmTimeoutMs,
  });
}
