/**
 * HTTP API schemas + tiny stdlib router.
 *
 * No Express. Routes are a flat array of `{ method, pattern, handler }`
 * where `pattern` is either a literal path or a `/v1/sessions/:id` style
 * placeholder pattern. Path params land in `req.params`.
 *
 * Body parsing: JSON if content-type is application/json, else raw text.
 * SSE: see writeSseEvent() — flushes a single event in the standard
 * `event:`/`data:` frame.
 */
import http from 'node:http';
import { URL } from 'node:url';

export interface Req {
  raw: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  /** Parsed body. JSON if content-type=application/json, raw string otherwise. */
  body: unknown;
  /** Auth token after bearer-prefix strip. May be empty. */
  token: string;
}

export type Handler = (req: Req) => Promise<void> | void;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

/** Match a pattern like `/v1/sessions/:id/messages` against `/v1/sessions/abc/messages`. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const q = pathname.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      params[p[i].slice(1)] = decodeURIComponent(q[i]);
    } else if (p[i] !== q[i]) {
      return null;
    }
  }
  return params;
}

/** Read the request body (capped at 1 MB) and parse it according to Content-Type. */
export function readBody(raw: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let overflow = false;
    raw.on('data', (c: Buffer) => {
      total += c.length;
      if (overflow) return; // already past the limit; discard
      if (total > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(c);
    });
    raw.on('end', () => {
      if (overflow) return reject(new HttpError(413, 'payload too large'));
      if (chunks.length === 0) return resolve(undefined);
      const buf = Buffer.concat(chunks);
      const ct = String(raw.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8'))); }
        catch (e: any) { reject(new HttpError(400, `invalid JSON: ${e.message}`)); }
      } else {
        resolve(buf.toString('utf8'));
      }
    });
    raw.on('error', reject);
  });
}

/** Send a JSON response. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

/** Send a plain-text error response. */
export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Write SSE preamble (call once before streaming events). */
export function sseStart(res: http.ServerResponse, requestId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'connection': 'keep-alive',
    'x-request-id': requestId,
  });
  // Suggest the client should not buffer.
  res.write(': hello\n\n');
}

/** Emit one SSE event. The data is JSON-encoded. */
export function sseEvent(res: http.ServerResponse, type: string, data: unknown): void {
  // SSE multi-line data must use repeated `data:` lines.
  const lines = JSON.stringify(data).split('\n');
  res.write(`event: ${type}\n`);
  for (const ln of lines) res.write(`data: ${ln}\n`);
  res.write('\n');
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'HttpError'; }
}

// ── route table dispatch ───────────────────────────────────────────────

export interface DispatchOptions {
  routes: Route[];
  /** Bearer token expected on every authed request. */
  authToken?: string;
  /** Optional per-request hook (logging). */
  onRequest?: (info: { method: string; pathname: string; status: number; durMs: number; requestId: string }) => void;
}

/**
 * Build the dispatch function passed to `http.createServer`. Handles routing,
 * auth, body parsing, error shaping.
 */
export function makeDispatch(opts: DispatchOptions): http.RequestListener {
  return async (raw, res) => {
    const startedAt = Date.now();
    const requestId = (raw.headers['x-request-id'] as string) || `req_${Math.random().toString(36).slice(2, 10)}`;
    res.setHeader('x-request-id', requestId);

    const url = new URL(raw.url || '/', `http://${raw.headers.host || 'localhost'}`);
    const method = (raw.method || 'GET').toUpperCase();
    let status = 200;
    let route: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of opts.routes) {
      if (r.method !== method && r.method !== '*') continue;
      const m = matchRoute(r.pattern, url.pathname);
      if (m) { route = r; params = m; break; }
    }

    try {
      if (!route) {
        status = 404;
        sendError(res, 404, `no route for ${method} ${url.pathname}`);
        return;
      }

      // Auth — skipped for unauthenticated routes (health, version).
      const requiresAuth = !UNAUTHED_PATTERNS.includes(route.pattern);
      let token = '';
      if (requiresAuth) {
        const header = String(raw.headers['authorization'] || '');
        if (!header.startsWith('Bearer ')) {
          status = 401;
          sendError(res, 401, 'missing or malformed Authorization header (expected `Bearer <token>`)');
          return;
        }
        token = header.slice('Bearer '.length).trim();
        if (opts.authToken && token !== opts.authToken) {
          status = 403;
          sendError(res, 403, 'invalid auth token');
          return;
        }
      }

      let body: unknown = undefined;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
        try { body = await readBody(raw); }
        catch (e: any) {
          if (e instanceof HttpError) { status = e.status; sendError(res, e.status, e.message); }
          else { status = 400; sendError(res, 400, e?.message || 'bad request'); }
          return;
        }
      }

      const reqObj: Req = { raw, res, url, method, params, body, token };
      await route.handler(reqObj);
      status = res.statusCode;
    } catch (e: any) {
      if (e instanceof HttpError) {
        status = e.status;
        if (!res.headersSent) sendError(res, e.status, e.message);
      } else {
        status = 500;
        if (!res.headersSent) sendError(res, 500, e?.message || 'internal error');
      }
    } finally {
      opts.onRequest?.({ method, pathname: url.pathname, status, durMs: Date.now() - startedAt, requestId });
    }
  };
}

const UNAUTHED_PATTERNS = ['/v1/health', '/v1/version', '/v1/metrics'];
