/**
 * web.fetch — HTTP GET with timeout and a hard size cap.
 *
 * Only GET. Only http/https. 2 MB cap. 30 s timeout. Honours ctx.signal.
 * Does NOT follow redirects to non-http(s) schemes, and does NOT auto-resolve
 * private IP literals — the framework leaves that as user responsibility.
 */
import { z } from 'zod';
import type { ToolDef } from '../core/types.js';

const MAX_RESPONSE_BYTES = 2_000_000;
const TIMEOUT_MS = 30_000;

const WebFetchSchema = z.object({
  url: z.string().url(),
  /** Extra headers to send. Authorization-like headers are NOT auto-filled. */
  headers: z.record(z.string()).optional(),
  /** When true, return bytes as base64 instead of trying utf8. */
  binary: z.boolean().default(false),
});

export const webFetchTool: ToolDef = {
  name: 'web.fetch',
  description: 'HTTP GET a URL. Returns up to 2MB of response body, prefixed with status and headers. 30s timeout. Only http/https.',
  permission: 'network',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http:// or https:// URL' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      binary: { type: 'boolean', description: 'Return base64 bytes; default false (utf8)' },
    },
    required: ['url'],
  },
  paramsSchema: WebFetchSchema,
  handler: async (raw, ctx) => {
    const args = WebFetchSchema.parse(raw);
    const parsed = new URL(args.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: unsupported protocol ${parsed.protocol}. Only http and https are allowed.`;
    }

    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(new Error(`web.fetch timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    const signal = composeSignals(ctx.signal, timeoutCtrl.signal);

    let resp: Response;
    try {
      resp = await fetch(args.url, {
        method: 'GET',
        headers: args.headers,
        signal,
        redirect: 'follow',
      });
    } catch (e: any) {
      clearTimeout(timer);
      return `Error: ${e.message}`;
    }

    // Stream-read with size cap.
    const reader = resp.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (total + value.byteLength > MAX_RESPONSE_BYTES) {
            const remaining = MAX_RESPONSE_BYTES - total;
            if (remaining > 0) chunks.push(value.subarray(0, remaining));
            truncated = true;
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        clearTimeout(timer);
      }
    } else {
      clearTimeout(timer);
    }

    const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    const headerLines: string[] = [];
    resp.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
    const body = args.binary
      ? buf.toString('base64')
      : buf.toString('utf8');

    const meta = [
      `HTTP ${resp.status} ${resp.statusText}`,
      `Final-URL: ${resp.url}`,
      ...headerLines,
      truncated ? `(body truncated at ${MAX_RESPONSE_BYTES} bytes)` : '',
      '',
    ].filter(Boolean).join('\n');

    return meta + '\n' + body;
  },
};

function composeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  a.addEventListener('abort', () => ctrl.abort(a.reason), { once: true });
  b.addEventListener('abort', () => ctrl.abort(b.reason), { once: true });
  return ctrl.signal;
}
