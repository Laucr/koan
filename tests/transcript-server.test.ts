import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/serve.js';
import { MemorySessionStore } from '../src/persistence/memory-store.js';
import { InMemoryUserMemoryStore } from '../src/persistence/user-memory-store.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('server transcript lifecycle', () => {
  it('creates and deletes a canonical transcript with the HTTP session', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'koan-http-transcript-'));
    temporary.push(root);
    const handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      authToken: 'test',
      sessionStore: new MemorySessionStore(),
      memoryStore: new InMemoryUserMemoryStore(),
      transcriptsEnabled: true,
      transcriptsDirectory: root,
      config: {
        provider: 'openai', model: 'mock', apiKey: 'dummy', llmTimeoutMs: 1000,
        transcripts: { enabled: true, directory: root },
        sources: { provider: 'flag', model: 'flag', apiKey: 'env' },
      },
    });
    try {
      const address = handle.address();
      const base = `http://127.0.0.1:${address.port}`;
      const createdResponse = await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as any;
      const files = await findJsonl(root);
      expect(files).toHaveLength(1);
      const first = JSON.parse((await fs.promises.readFile(files[0], 'utf8')).trim());
      expect(first).toMatchObject({ schema_version: 1, session_id: created.id, type: 'session.started' });

      const deleted = await fetch(`${base}/v1/sessions/${created.id}`, {
        method: 'DELETE', headers: { authorization: 'Bearer test' },
      });
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(files[0])).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

async function findJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.jsonl')) out.push(target);
    }
  };
  await walk(root);
  return out;
}
