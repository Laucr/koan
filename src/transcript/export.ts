import fs from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from '../persistence/session-store.js';
import { claudeEventsFromSession } from './claude.js';
import { codexEventsFromSession } from './codex.js';
import { transcriptFromSession } from './from-session.js';
import { encodeJsonl } from './koan.js';
import type { TranscriptFormat } from './types.js';

export function exportSessionJsonl(record: SessionRecord, format: TranscriptFormat): string {
  if (format === 'koan') return encodeJsonl(transcriptFromSession(record));
  if (format === 'codex') return encodeJsonl(codexEventsFromSession(record));
  return encodeJsonl(claudeEventsFromSession(record));
}

export async function writeSessionExport(
  record: SessionRecord,
  format: TranscriptFormat,
  outputPath: string,
): Promise<void> {
  const resolved = path.resolve(outputPath);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.promises.writeFile(temporary, exportSessionJsonl(record, format), { mode: 0o600 });
    await fs.promises.rename(temporary, resolved);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
