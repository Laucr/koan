/**
 * M9 tests — metrics registry, cost calculation, /cost slash, /v1/metrics endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  MetricsRegistry, getMetrics, resetMetrics,
  costFor, formatCost,
  startServer, type ServerHandle,
  MemorySessionStore, InMemoryUserMemoryStore,
} from '../src/index.js';
import { handleSlash } from '../src/cli/slash.js';
import { ReplSession } from '../src/cli/session.js';

// ── MetricsRegistry ────────────────────────────────────────────────────

describe('MetricsRegistry', () => {
  it('counters accumulate across label sets', () => {
    const m = new MetricsRegistry();
    m.counter('koan_x', { kind: 'a' }, 1, 'help');
    m.counter('koan_x', { kind: 'a' }, 2);
    m.counter('koan_x', { kind: 'b' }, 5);
    const out = m.render();
    expect(out).toMatch(/koan_x\{kind="a"\} 3/);
    expect(out).toMatch(/koan_x\{kind="b"\} 5/);
    expect(out).toMatch(/# HELP koan_x help/);
    expect(out).toMatch(/# TYPE koan_x counter/);
  });

  it('gauges replace, not accumulate', () => {
    const m = new MetricsRegistry();
    m.gauge('g', {}, 1);
    m.gauge('g', {}, 7);
    expect(m.render()).toMatch(/g 7/);
  });

  it('histograms render le buckets + sum + count', () => {
    const m = new MetricsRegistry();
    m.observe('lat', { route: 'x' }, 0.05);
    m.observe('lat', { route: 'x' }, 1.5);
    const out = m.render();
    expect(out).toMatch(/lat_bucket\{le=".*",route="x"\}/);
    expect(out).toMatch(/lat_sum\{route="x"\} 1.55/);
    expect(out).toMatch(/lat_count\{route="x"\} 2/);
  });

  it('label values are escaped', () => {
    const m = new MetricsRegistry();
    m.counter('x', { path: 'has "quotes" and\\backslash' }, 1);
    expect(m.render()).toMatch(/has \\"quotes\\" and\\\\backslash/);
  });

  it('global registry is a singleton until reset', () => {
    resetMetrics();
    const a = getMetrics();
    a.counter('z', {}, 1);
    expect(getMetrics()).toBe(a);
    resetMetrics();
    expect(getMetrics()).not.toBe(a);
  });
});

// ── Cost ────────────────────────────────────────────────────────────────

describe('costFor', () => {
  it('returns the correct USD for a known model', () => {
    // gpt-4o-mini: $0.15/$0.60 per 1M
    const usd = costFor('gpt-4o-mini', 1_000_000, 1_000_000);
    expect(usd).toBeCloseTo(0.75, 5);
  });

  it('returns 0 for zero tokens', () => {
    expect(costFor('gpt-4o-mini', 0, 0)).toBe(0);
  });

  it('returns null for an unknown model', () => {
    expect(costFor('made-up-model-9000', 100, 100)).toBeNull();
  });

  it('matches a known model by prefix', () => {
    // Suffix variants (gpt-4o-2024-08-06) should fall back to gpt-4o.
    const usd = costFor('gpt-4o-2024-08-06', 1_000_000, 0);
    expect(usd).toBe(2.5);
  });
});

describe('formatCost', () => {
  it('renders null as "(unknown)"', () => {
    expect(formatCost(null)).toBe('(unknown)');
  });
  it('renders sub-cent values', () => {
    expect(formatCost(0.00005)).toBe('<$0.0001');
  });
  it('renders 4 decimals under $1', () => {
    expect(formatCost(0.1234)).toBe('$0.1234');
  });
  it('renders 2 decimals at $1+', () => {
    expect(formatCost(12.345)).toBe('$12.35');
  });
});

// ── /cost slash command ────────────────────────────────────────────────

describe('/cost slash command', () => {
  it('reports model + tokens + estimated USD', async () => {
    const store = new MemorySessionStore();
    const rec = await store.create({
      id: 'cost-test',
      profile: 'default', provider: 'openai', model: 'gpt-4o-mini',
      cwd: '/tmp', permissions: ['read'],
      usage: { promptTokens: 1_000_000, completionTokens: 500_000, toolCalls: 3, rounds: 2 },
      messages: [],
    });
    const session = new ReplSession({
      initialPermissions: new Set(), model: 'gpt-4o-mini', provider: 'openai',
    });
    const r = await handleSlash('/cost', {
      session,
      sessionStore: store,
      sessionId: rec.id,
    });
    expect(r.kind).toBe('continue');
    expect(r.message).toMatch(/gpt-4o-mini/);
    expect(r.message).toMatch(/1000000 tokens/);
    expect(r.message).toMatch(/\$0\./);
  });

  it('reports "(cost requires a persisted session)" without a store', async () => {
    const r = await handleSlash('/cost', {
      session: new ReplSession({ initialPermissions: new Set(), model: 'x', provider: 'openai' }),
    });
    expect(r.message).toMatch(/persisted session/);
  });
});

// ── /v1/metrics endpoint ───────────────────────────────────────────────

let handle: ServerHandle;
let url: { host: string; port: number };

beforeAll(async () => {
  resetMetrics();
  handle = await startServer({
    port: 0, host: '127.0.0.1',
    authToken: 'tok',
    sessionStore: new MemorySessionStore(),
    memoryStore: new InMemoryUserMemoryStore(),
    config: {
      provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
      llmTimeoutMs: 60_000,
      sources: { provider: 'flag', model: 'flag', apiKey: 'flag' },
    } as any,
  });
  url = handle.address();
});

afterAll(async () => {
  await handle.close();
});

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.request({ host: url.host, port: url.port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}

describe('GET /v1/metrics', () => {
  it('is unauthenticated', async () => {
    const r = await get('/v1/metrics');
    expect(r.status).toBe(200);
  });

  it('serves Prometheus text format', async () => {
    const r = await get('/v1/metrics');
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.body).toMatch(/# TYPE koan_/);
  });

  it('includes the gauge for active sessions', async () => {
    const r = await get('/v1/metrics');
    expect(r.body).toMatch(/koan_active_sessions/);
    expect(r.body).toMatch(/koan_pending_approvals/);
  });

  it('records http counters across requests', async () => {
    // Make a request to /version so the http counter advances.
    await get('/v1/version');
    const r = await get('/v1/metrics');
    expect(r.body).toMatch(/koan_http_requests_total\{[^}]*path="\/v1\/version"/);
  });
});
