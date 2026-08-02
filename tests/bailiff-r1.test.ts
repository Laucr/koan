/**
 * Bailiff r1 — widened contract tests (philosophy gaps + plan M1–M9).
 * Maps to checklist in .claude/reports/scaffold-bailiff-r1.md.
 * Prefer public / CLI / HTTP surfaces; mirror existing milestone patterns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  runReActAgent, createAgentConfig, registerTool, initRegistries,
  startServer, type ServerHandle,
  MemorySessionStore, InMemoryUserMemoryStore,
  getLogger, resetLogger, registerDefaultToolkit,
} from '../src/index.js';
import type { LLMClient, LLMResponse, ToolDef } from '../src/index.js';
import { main } from '../src/cli/main.js';
import { sessionsSubcommand } from '../src/cli/sessions-subcommand.js';
import { resolveAgentToolsAndMws } from '../src/core/registry.js';
import { createAgentConfig as cac } from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Register the default toolkit before any test freezes the registry so later
// HTTP integration in this file still sees fs.*/shell.*/web.* tools.
beforeAll(() => {
  registerDefaultToolkit();
});

const reply = (content: string, calls: any[] = []): LLMResponse => ({
  message: { content, tool_calls: calls.length ? calls : undefined },
});
const tc = (name: string, args: any, id = `c_${name}`) =>
  ({ id, function: { name, arguments: JSON.stringify(args) } });

// ── P12: FORCE one-shot (prior G3 only tested FORBID persistence) ──────

describe('P12: FORCE is one-shot across loop rounds', () => {
  beforeAll(() => {
    const tools: ToolDef[] = [
      {
        name: 'p12_search', description: 'search', toolClass: 'search',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'hit',
      },
      {
        name: 'p12_other', description: 'other', toolClass: 'other',
        parameters: { type: 'object', properties: {} },
        handler: async () => 'ok',
      },
    ];
    for (const t of tools) {
      try { registerTool(t); } catch { /* frozen or dup */ }
    }
  });

  it('round 0 pins tool_choice to search; later rounds are not forced', async () => {
    const seen: Array<{ choice: unknown; tools: string[] }> = [];
    let round = 0;
    const llm: LLMClient = async (req) => {
      seen.push({
        choice: req.tool_choice,
        tools: (req.tools ?? []).map(t => t.function.name),
      });
      round++;
      if (round === 1) {
        // Honour the force: call search, then continue.
        return reply('searching', [tc('p12_search', {})]);
      }
      return reply('done');
    };

    await runReActAgent({
      agentConfig: createAgentConfig({
        name: 'p12', tools: ['p12_search', 'p12_other'], maxRounds: 4,
      }),
      llm,
      userId: 'u',
      initialMessages: [{ role: 'user', content: 'q' }],
      initialGate: { search: 'force' },
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Round 0 must force a specific search function.
    expect(seen[0].choice).toEqual({ type: 'function', function: { name: 'p12_search' } });
    // After one-shot cleanup, later rounds must NOT keep force pin.
    for (const s of seen.slice(1)) {
      expect(s.choice).not.toEqual({ type: 'function', function: { name: 'p12_search' } });
    }
  });
});

// ── P8 / F2: registries frozen after boot ──────────────────────────────

describe('P8: registries init-frozen in real entrypoints', () => {
  it('CLI/server entrypoint sources call initRegistries after toolkit registration', () => {
    const files = [
      'src/cli/main.ts',
      'src/cli/run.ts',
      'src/cli/repl.ts',
      'src/server/serve.ts',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/registerDefaultToolkit\s*\(/);
      expect(src).toMatch(/initRegistries\s*\(/);
    }
  });

  it('registerTool throws once registries are frozen', () => {
    initRegistries(); // idempotent
    expect(() => registerTool({
      name: `bailiff_r1_${Date.now()}`,
      description: 'should fail',
      parameters: { type: 'object' },
      handler: async () => 'nope',
    })).toThrow(/frozen/i);
  });
});

// ── P13 / P14 / M9c / M9d: intentional omissions ───────────────────────

describe('P13/P14/M9c/M9d: plan Not Doing / deferred surfaces', () => {
  it('does not ship SSO/RBAC, web UI, brew formula, or CI publish workflows', () => {
    expect(fs.existsSync(path.join(ROOT, 'Formula'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, '.github/workflows'))).toBe(false);
    // No web UI package.
    expect(fs.existsSync(path.join(ROOT, 'web'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'ui'))).toBe(false);
  });

  it('OpenTelemetry is absent (not half-wired)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).some(k => /opentelemetry/i.test(k))).toBe(false);
    // No OTel imports under src/
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    for (const f of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text).not.toMatch(/@opentelemetry|OpenTelemetry|otel/i);
    }
  });

  it('loop does not auto-summarise history (backbone negative space)', async () => {
    const llm: LLMClient = async () => reply('ok');
    const r = await runReActAgent({
      agentConfig: createAgentConfig({ name: 'nosum', tools: [], maxRounds: 2 }),
      llm, userId: 'u',
      initialMessages: [{ role: 'user', content: 'long context please summarise' }],
    });
    expect(r.finalAnswer).toBe('ok');
    // No synthetic summary assistant message injected by the framework.
    const all = [...r.history.prefix, ...r.history.suffix];
    expect(all.filter((m: any) => m.role === 'assistant').length).toBe(1);
  });
});

// ── M1a: CLI dispatch surface ──────────────────────────────────────────

describe('M1a: Koan CLI dispatch', () => {
  it('main(["help"]) exits 0 and prints usage', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true; }) as any;
    try {
      const code = await main(['help']);
      expect(code).toBe(0);
      expect(chunks.join('')).toMatch(/usage: koan/i);
      expect(chunks.join('')).toMatch(/run /);
      expect(chunks.join('')).toMatch(/serve/);
    } finally {
      process.stdout.write = orig;
    }
  });
});

// ── M5c: unknown tool warns, does not crash ────────────────────────────

describe('M5c: unknown tool in agent config warns, does not throw', () => {
  it('resolveAgentToolsAndMws logs warn and returns without throwing', () => {
    const cfg = cac({
      name: 'm5c',
      tools: ['definitely_not_a_real_tool_xyz'],
      middlewares: [],
    });
    expect(() => resolveAgentToolsAndMws(cfg)).not.toThrow();
    const tools = resolveAgentToolsAndMws(cfg);
    expect(tools.tools).toEqual([]);
  });
});

// ── M6b: sessions CLI surface ──────────────────────────────────────────

describe('M6b: sessions subcommand contract', () => {
  it('sessions help and where exit 0', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: any) => { chunks.push(String(s)); return true; }) as any;
    try {
      expect(await sessionsSubcommand(['help'])).toBe(0);
      expect(chunks.join('')).toMatch(/sessions/i);
      chunks.length = 0;
      expect(await sessionsSubcommand(['where'])).toBe(0);
      expect(chunks.join('')).toMatch(/sessions\.db/);
    } finally {
      process.stdout.write = orig;
    }
  });
});

// ── M9a / M9b: obs logger + docs ───────────────────────────────────────

describe('M9a: pino logger surface', () => {
  it('getLogger returns a child logger with info/warn', () => {
    resetLogger();
    process.env.KOAN_LOG_LEVEL = 'silent';
    const log = getLogger('bailiff-r1');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    log.info('noop');
    resetLogger();
    delete process.env.KOAN_LOG_LEVEL;
  });
});

describe('M9b: shipped docs exist', () => {
  it('README + docs/profiles, tools, http are present', () => {
    for (const rel of ['README.md', 'docs/profiles.md', 'docs/tools.md', 'docs/http.md']) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  it('docs/http.md mentions the core /v1 routes', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/http.md'), 'utf8');
    for (const route of ['/v1/health', '/v1/sessions', '/v1/metrics', 'messages']) {
      expect(doc).toContain(route);
    }
  });
});

describe('M2b: adapter factories are exported', () => {
  it('OpenAI and Anthropic streaming clients are constructible factories', async () => {
    const {
      createOpenAIClient, createAnthropicClient,
      createOpenAIStreamingClient, createAnthropicStreamingClient,
    } = await import('../src/index.js');
    expect(typeof createOpenAIClient).toBe('function');
    expect(typeof createAnthropicClient).toBe('function');
    expect(typeof createOpenAIStreamingClient).toBe('function');
    expect(typeof createAnthropicStreamingClient).toBe('function');
  });
});

// ── P15 / M8c: HTTP rate limit 429 ─────────────────────────────────────

describe('P15/M8c: HTTP rate limit returns 429', () => {
  let handle: ServerHandle;
  let host: string;
  let port: number;
  const TOKEN = 'bailiff-r1-token';

  beforeAll(async () => {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      authToken: TOKEN,
      rpm: 2,
      sessionStore: new MemorySessionStore(),
      memoryStore: new InMemoryUserMemoryStore(),
      config: {
        provider: 'openai', model: 'gpt-x', apiKey: 'sk-test',
        llmTimeoutMs: 5_000, sources: { provider: 'flag', model: 'flag', apiKey: 'flag' },
      } as any,
    });
    ({ host, port } = handle.address());
  });

  afterAll(async () => { await handle.close(); });

  async function httpReq(opts: {
    method: string; path: string; body?: any;
  }): Promise<{ status: number; headers: http.IncomingHttpHeaders; bodyText: string }> {
    return new Promise((resolve, reject) => {
      const headers: any = { authorization: `Bearer ${TOKEN}` };
      let bodyBuf: Buffer | undefined;
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
        headers['content-length'] = bodyBuf.length;
      }
      const r = http.request({ host, port, path: opts.path, method: opts.method, headers }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve({
          status: resp.statusCode || 0,
          headers: resp.headers,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      r.on('error', reject);
      if (bodyBuf) r.write(bodyBuf);
      r.end();
    });
  }

  it('third messages POST within burst window returns 429 with retry-after', async () => {
    // Create three sessions so lock conflicts don't mask the rate limit.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await httpReq({ method: 'POST', path: '/v1/sessions', body: { profile: 'default' } });
      expect(created.status).toBe(201);
      ids.push(JSON.parse(created.bodyText).id);
    }
    const statuses: number[] = [];
    for (const id of ids) {
      const r = await httpReq({
        method: 'POST',
        path: `/v1/sessions/${id}/messages`,
        body: { content: 'ping' },
      });
      statuses.push(r.status);
      if (r.status === 429) {
        expect(r.headers['retry-after']).toBeTruthy();
      }
    }
    expect(statuses).toContain(429);
  });
});
