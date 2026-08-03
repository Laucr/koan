import fs from 'node:fs';
import type { SessionRecord } from '../persistence/session-store.js';
import { sessionStartedEvent } from './koan.js';
import { defaultTranscriptRoot, transcriptPathFor } from './path.js';
import { JsonlTranscriptWriter } from './writer.js';

export async function ensureTranscriptRoot(root: string = defaultTranscriptRoot()): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  await fs.promises.access(root, fs.constants.R_OK | fs.constants.W_OK);
}

export async function openSessionTranscript(
  record: SessionRecord,
  root: string = defaultTranscriptRoot(),
): Promise<JsonlTranscriptWriter> {
  const filePath = transcriptPathFor(record.id, record.createdAt, root);
  let empty = true;
  try {
    empty = (await fs.promises.stat(filePath)).size === 0;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const writer = await JsonlTranscriptWriter.open({ path: filePath, sessionId: record.id });
  if (empty) await writer.append([sessionStartedEvent(record)]);
  return writer;
}
