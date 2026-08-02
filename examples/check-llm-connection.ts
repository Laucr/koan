/**
 * Smoke-test an OpenAI-compatible server through this repo's LLM adapter.
 *
 * Defaults to http://127.0.0.1:8000/v1 and discovers the first model from
 * GET /v1/models. Override either value with KOAN_BASE_URL / KOAN_MODEL.
 */
import { createOpenAIClient } from '../src/adapters/openai.js';

function normalizedBaseURL(value: string): string {
  const url = new URL(value);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '') pathname = '/v1';
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

async function discoverModel(baseURL: string, apiKey: string): Promise<string> {
  const response = await fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${baseURL}/models returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json() as { data?: Array<{ id?: string }> };
  const model = body.data?.find(item => typeof item.id === 'string')?.id;
  if (!model) {
    throw new Error('The models response did not contain a model id; set KOAN_MODEL explicitly.');
  }
  return model;
}

async function main(): Promise<void> {
  const baseURL = normalizedBaseURL(process.env.KOAN_BASE_URL ?? 'http://127.0.0.1:8000');
  const apiKey = process.env.KOAN_API_KEY ?? process.env.OPENAI_API_KEY ?? 'sk-dummy';
  const model = process.env.KOAN_MODEL ?? await discoverModel(baseURL, apiKey);

  process.stdout.write(`Connecting to ${baseURL} with model ${model} ...\n`);
  const llm = createOpenAIClient({ apiKey, baseURL, defaultTimeoutMs: 15_000 });
  const response = await llm({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: CONNECTION_OK' }],
  });

  const content = response.message.content?.trim();
  if (!content) throw new Error('The server returned an empty assistant message.');
  process.stdout.write(`Connected. Server replied: ${content}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Connection check failed: ${message}\n`);
  process.exitCode = 1;
});
