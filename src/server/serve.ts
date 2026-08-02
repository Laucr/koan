/**
 * HTTP server — wraps the same loop + stores the CLI uses.
 *
 * Endpoints (all under /v1):
 *   GET  /health                          → { status, uptime }
 *   GET  /version                         → { version }
 *   POST /sessions                        → create a session
 *   GET  /sessions                        → list sessions (newest first)
 *   GET  /sessions/:id                    → full record
 *   DELETE /sessions/:id                  → delete
 *   POST /sessions/:id/messages           → SSE stream of the next turn
 *   POST /sessions/:id/messages/cancel    → abort the in-flight turn
 *   POST /sessions/:id/approvals/:apid    → resolve a pending tool approval
 *
 * Auth: bearer token via `KOAN_AUTH_TOKEN` or `--auth-token`. Health and
 * version are unauthenticated.
 *
 * Concurrency: at most one in-flight message per session. Second concurrent
 * POST returns 409.
 *
 * Rate limit: token-bucket, default 60 req/min per token.
 *
 * Graceful shutdown: SIGTERM stops accepting new requests; drains in-flight
 * runs up to a 30-second deadline; closes stores.
 */
import http from 'node:http';
import {
  type Route, type Req, type Handler,
  sendJson, sendError, sseStart, sseEvent, HttpError, makeDispatch, matchRoute,
} from './http.js';
import { ApprovalCoordinator, previewArgs } from './approval.js';
import { SessionRunLock } from './lock.js';
import { RateLimiter } from './rate-limit.js';
import {
  type SessionStore, type UserMemoryStore,
  SqliteSessionStore, SqliteUserMemoryStore, defaultSessionsDbPath,
  newSessionId, memoryFetcherFor,
} from '../persistence/index.js';
import { PendingWriteQueue } from '../core/memory.js';
import { resolveConfig, type ResolvedConfig } from '../cli/config.js';
import { buildStreamingLLMClient } from '../cli/provider.js';
import { resolveProfile, BUILTIN_PROFILES, type Profile } from '../cli/profile.js';
import { buildEffectiveConfig } from '../cli/effective.js';
import { runTurn } from '../persistence/runner.js';
import { createAgentConfig } from '../config/agent-loader.js';
import { registerDefaultToolkit } from '../tools/index.js';
import { initRegistries } from '../core/registry.js';
import type { LLMStreamEvent } from '../core/streaming.js';
import type { ToolApprover, ToolApproval } from '../core/loop.js';
import { getLogger } from '../obs/log.js';
import { getMetrics } from '../obs/metrics.js';
import type { ToolPermission, RawMessage } from '../core/types.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  authToken?: string;
  /** Max requests per minute per bearer token. Default 60. */
  rpm?: number;
  /** Per-LLM-call timeout in ms. */
  llmTimeoutMs?: number;
  /** Working directory for fs.* tools. */
  cwd?: string;
  /** Pre-resolved config (tests). */
  config?: ResolvedConfig;
  /** Inject stores (tests). */
  sessionStore?: SessionStore;
  memoryStore?: UserMemoryStore;
  /** Approval timeout in ms. Defaults to 60s. */
  approvalTimeoutMs?: number;
}

const VERSION = '0.2.0';

export interface ServerHandle {
  close(): Promise<void>;
  /** The bound address; useful for tests when port=0. */
  address(): { host: string; port: number };
}

export async function startServer(opts: ServeOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? 8787;
  const host = opts.host ?? '127.0.0.1';
  const authToken = opts.authToken ?? process.env.KOAN_AUTH_TOKEN ?? '';
  const cwd = opts.cwd ?? process.cwd();
  const log = getLogger('server', { host, port });

  if (!authToken) {
    log.warn('no auth token configured (--auth-token or KOAN_AUTH_TOKEN); the server accepts any Bearer value');
  }

  // Make sure tools are registered before the first run, then freeze.
  // tool_middleware_chain.md §8: "Validation at startup, warning at request" —
  // initRegistries panics on duplicate middleware before serving traffic.
  registerDefaultToolkit();
  initRegistries();

  const resolved = opts.config ?? resolveConfig({});

  const dbPath = defaultSessionsDbPath();
  const sessionStore = opts.sessionStore ?? new SqliteSessionStore({ filePath: dbPath });
  const memoryStore = opts.memoryStore ?? new SqliteUserMemoryStore({ filePath: dbPath });

  const lock = new SessionRunLock();
  const limiter = new RateLimiter({ rpm: opts.rpm ?? 60 });
  const approvals = new ApprovalCoordinator();
  // Pending-write queues are per-session (so one session can't accept
  // another's stage). Reaped on session DELETE.
  const pendingByession = new Map<string, PendingWriteQueue>();
  function pendingFor(id: string): PendingWriteQueue {
    let q = pendingByession.get(id);
    if (!q) { q = new PendingWriteQueue(); pendingByession.set(id, q); }
    return q;
  }

  const startedAt = Date.now();
  let acceptingRequests = true;

  // ── route handlers ────────────────────────────────────────────────────

  const healthHandler: Handler = (req) => {
    sendJson(req.res, 200, { status: 'ok', uptime: (Date.now() - startedAt) / 1000 });
  };
  const versionHandler: Handler = (req) => {
    sendJson(req.res, 200, { version: VERSION });
  };
  const metricsHandler: Handler = (req) => {
    // Record active sessions / pending approvals on every scrape so the
    // gauge tracks reality.
    const metrics = getMetrics();
    metrics.gauge('koan_active_sessions', {}, lock.size(), 'In-flight runs.');
    metrics.gauge('koan_pending_approvals', {}, approvals.size(), 'Approvals awaiting client decision.');
    const body = metrics.render();
    req.res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    });
    req.res.end(body);
  };

  const createSessionHandler: Handler = async (req) => {
    if (!acceptingRequests) throw new HttpError(503, 'server is draining');
    const body = (req.body ?? {}) as any;
    const profileName: string | undefined = body.profile;
    const provider: string | undefined = body.provider;
    const model: string | undefined = body.model;
    const permissions: ToolPermission[] = Array.isArray(body.permissions) ? body.permissions : ['read'];

    let profileResolution;
    try {
      profileResolution = resolveProfile({ flag: profileName });
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
    const id = newSessionId();
    await sessionStore.create({
      id,
      profile: profileResolution.name,
      provider: provider ?? resolved.provider,
      model: model ?? resolved.model,
      cwd,
      permissions,
      usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, rounds: 0 },
      messages: [],
    });
    const rec = await sessionStore.get(id);
    sendJson(req.res, 201, rec);
  };

  const listSessionsHandler: Handler = async (req) => {
    const limit = Number(req.url.searchParams.get('limit') ?? '50');
    const profile = req.url.searchParams.get('profile') ?? undefined;
    const list = await sessionStore.list({ limit, profile });
    sendJson(req.res, 200, { sessions: list });
  };

  const getSessionHandler: Handler = async (req) => {
    const rec = await sessionStore.get(req.params.id);
    if (!rec) throw new HttpError(404, 'session not found');
    sendJson(req.res, 200, rec);
  };

  const deleteSessionHandler: Handler = async (req) => {
    approvals.cancelSession(req.params.id);
    lock.abort(req.params.id, new Error('session deleted'));
    pendingByession.delete(req.params.id);
    const ok = await sessionStore.delete(req.params.id);
    if (!ok) throw new HttpError(404, 'session not found');
    sendJson(req.res, 200, { deleted: req.params.id });
  };

  const cancelMessageHandler: Handler = (req) => {
    const aborted = lock.abort(req.params.id, new Error('cancelled via HTTP'));
    sendJson(req.res, 200, { cancelled: aborted });
  };

  const approveHandler: Handler = (req) => {
    const body = (req.body ?? {}) as any;
    const decision = body.decision as ToolApproval;
    if (!['allow', 'deny', 'always'].includes(decision)) {
      throw new HttpError(400, 'body must include decision: "allow" | "deny" | "always"');
    }
    const ok = approvals.resolveById(req.params.id, req.params.apid, decision);
    if (!ok) throw new HttpError(404, 'no pending approval matches this id (already resolved or expired)');
    sendJson(req.res, 200, { ok: true });
  };

  // The big one: stream a turn over SSE.
  const messagesHandler: Handler = async (req) => {
    if (!acceptingRequests) throw new HttpError(503, 'server is draining');

    // Rate limit: per-token (or per-host if anon).
    const rl = limiter.try(req.token || req.url.host || 'anon');
    if (!rl.ok) {
      req.res.setHeader('retry-after', String(Math.ceil(rl.retryAfterMs / 1000)));
      throw new HttpError(429, `rate limit; retry after ${rl.retryAfterMs}ms`);
    }

    const sessionId = req.params.id;
    const rec = await sessionStore.get(sessionId);
    if (!rec) throw new HttpError(404, 'session not found');

    const body = (req.body ?? {}) as any;
    const text = typeof body.content === 'string' ? body.content : '';
    if (!text.trim()) throw new HttpError(400, 'body must include `content` (non-empty string)');

    // Acquire the per-session lock.
    const acquired = lock.tryAcquire(sessionId, req.res.getHeader('x-request-id') as string);
    if (!acquired.ok) {
      throw new HttpError(409, `session is busy; another request (${acquired.conflict.requestId}) is in flight`);
    }

    // Resolve effective config from the session's profile.
    const profile: Profile = BUILTIN_PROFILES[rec.profile]
      ?? (() => {
        try { return resolveProfile({ flag: rec.profile }).profile; }
        catch { return BUILTIN_PROFILES.default; }
      })();
    const effective = buildEffectiveConfig({
      profile,
      approveMode: 'none',
    });
    // Permissions come from the session record, not the profile, because
    // the client may have widened them at create time.
    const permissions = new Set<ToolPermission>(rec.permissions);

    sseStart(req.res, req.res.getHeader('x-request-id') as string);

    // Build a coordinator-backed approver.
    const approver: ToolApprover = async (info) => {
      return approvals.request({
        sessionId,
        toolName: info.toolName,
        argsPreview: previewArgs(info.args),
        timeoutMs: opts.approvalTimeoutMs ?? 60_000,
        emit: (evt) => sseEvent(req.res, 'approval_needed', evt),
      });
    };

    const pendingWrites = pendingFor(sessionId);

    try {
      const history: RawMessage[] = [...rec.messages, { role: 'user', content: text }];
      const cfg = createAgentConfig({
        name: rec.profile,
        model: rec.model,
        maxRounds: effective.maxRounds,
        tools: effective.toolNames,
        middlewares: [],
        systemPromptTemplate: effective.systemPrompt,
      });

      const result = await runTurn({
        store: sessionStore,
        sessionId,
        history,
        agentConfig: cfg,
        streamLLM: buildStreamingLLMClient(resolved),
        onStreamEvent: (e: LLMStreamEvent) => {
          // Forward every event into SSE. The client can render
          // text deltas or pretty-print tool calls.
          if (e.type === 'done') {
            // We send `done` after persistence finishes; skip the inner one.
            return;
          }
          if (e.type === 'error') {
            sseEvent(req.res, 'error', { message: e.error.message });
            return;
          }
          // Other events: text_delta / tool_call_*
          sseEvent(req.res, e.type, e);
        },
        userId: req.token || 'local',
        signal: acquired.abort.signal,
        llmTimeoutMs: opts.llmTimeoutMs ?? resolved.llmTimeoutMs,
        permissions,
        toolApprover: approver,
        cwd,
        allowedPaths: [cwd],
        initialSearchGate: profile.defaultSearchGate,
        // M7: only wire the across-conv memory pipeline when the session's
        // profile explicitly opts in (memory_mechanism.md §8).
        userMemoryFetcher: profile.acrossConversationMemory ? memoryFetcherFor(memoryStore) : undefined,
        pendingMemoryWrites: pendingWrites,
      });

      // Final event: the whole result (without the raw history — the client
      // can GET the session if it wants the full record).
      sseEvent(req.res, 'done', {
        finalAnswer: result.finalAnswer,
        toolCallsMade: result.toolCallsMade,
        rounds: result.rounds,
        warnings: result.warnings,
        usage: result.usage,
        pendingMemoryWrites: pendingWrites.list(),
      });
      req.res.end();
    } catch (e: any) {
      sseEvent(req.res, 'error', { message: e?.message || String(e) });
      req.res.end();
    } finally {
      lock.release(sessionId);
    }
  };

  // ── routes ────────────────────────────────────────────────────────────

  const routes: Route[] = [
    { method: 'GET',    pattern: '/v1/health',                           handler: healthHandler },
    { method: 'GET',    pattern: '/v1/version',                          handler: versionHandler },
    { method: 'GET',    pattern: '/v1/metrics',                          handler: metricsHandler },
    { method: 'POST',   pattern: '/v1/sessions',                         handler: createSessionHandler },
    { method: 'GET',    pattern: '/v1/sessions',                         handler: listSessionsHandler },
    { method: 'GET',    pattern: '/v1/sessions/:id',                     handler: getSessionHandler },
    { method: 'DELETE', pattern: '/v1/sessions/:id',                     handler: deleteSessionHandler },
    { method: 'POST',   pattern: '/v1/sessions/:id/messages',            handler: messagesHandler },
    { method: 'POST',   pattern: '/v1/sessions/:id/messages/cancel',     handler: cancelMessageHandler },
    { method: 'POST',   pattern: '/v1/sessions/:id/approvals/:apid',     handler: approveHandler },
  ];

  const dispatch = makeDispatch({
    routes, authToken: authToken || undefined,
    onRequest: (info) => {
      log.info({ requestId: info.requestId, method: info.method, path: info.pathname, status: info.status, durMs: info.durMs }, 'request');
      // Match against the route table so the path label has bounded cardinality.
      const pattern = matchRoutePattern(routes, info.method, info.pathname) ?? '(unknown)';
      const m = getMetrics();
      m.counter('koan_http_requests_total', { method: info.method, path: pattern, status: String(info.status) }, 1, 'HTTP requests.');
      m.observe('koan_http_request_duration_seconds', { method: info.method, path: pattern }, info.durMs / 1000, 'HTTP request latency.');
    },
  });

  const server = http.createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  log.info({ port: (server.address() as any).port }, 'listening');

  // SIGTERM drain: stop accepting, wait for in-flight runs to finish,
  // close stores. Test harness can call handle.close() instead.
  const onSigterm = () => { void handle.close(); };
  process.on('SIGTERM', onSigterm);

  const handle: ServerHandle = {
    address() {
      const addr = server.address() as any;
      return { host: addr.address, port: addr.port };
    },
    async close() {
      acceptingRequests = false;
      // Stop accepting new connections.
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      // Wait up to 30s for in-flight runs.
      const deadline = Date.now() + 30_000;
      while (lock.size() > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      // Force-abort anything still running.
      for (const run of lock.activeRuns()) run.abort.abort(new Error('server shutdown'));
      sessionStore.close?.();
      memoryStore.close?.();
      approvals.cancelSession('*');
      process.off('SIGTERM', onSigterm);
    },
  };
  return handle;
}

function matchRoutePattern(routes: Route[], method: string, pathname: string): string | null {
  for (const r of routes) {
    if (r.method !== method && r.method !== '*') continue;
    if (matchRoute(r.pattern, pathname)) return r.pattern;
  }
  return null;
}
