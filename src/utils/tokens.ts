/**
 * Token counting. Convert once, read many. Cache on messages.
 * (history_processing.md)
 */
import { encode } from 'gpt-tokenizer';

const TOKENIZER_MODEL = 'gpt-4o'; // good approx for most

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // rough fallback: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

export function countToolCallTokens(tc: { name: string; arguments: unknown }): number {
  const s = JSON.stringify({ name: tc.name, arguments: tc.arguments });
  return countTokens(s) + 10; // overhead
}

export function countMessageTokens(msg: { role: string; content?: string | null; toolCalls?: any[] }): number {
  let n = 4; // role etc
  if (msg.content) n += countTokens(msg.content);
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) n += countToolCallTokens(tc);
  }
  return n;
}
