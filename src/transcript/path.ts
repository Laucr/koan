import os from 'node:os';
import path from 'node:path';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function defaultTranscriptRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const dataRoot = env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(dataRoot, 'koan', 'transcripts');
}

export function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`Unsafe session id for transcript path: ${JSON.stringify(sessionId)}`);
  }
}

export function transcriptPathFor(
  sessionId: string,
  createdAt: string,
  root: string = defaultTranscriptRoot(),
): string {
  assertSafeSessionId(sessionId);
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid session timestamp: ${createdAt}`);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, yyyy, mm, dd, `${sessionId}.jsonl`);
  if (!candidate.startsWith(resolvedRoot + path.sep)) throw new Error('Transcript path escaped its root');
  return candidate;
}
