import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { redactTranscriptValue } from './redact.js';
import type { KoanTranscriptEvent, NewTranscriptEvent, TranscriptSink } from './types.js';

export interface TranscriptWriterOptions {
  path: string;
  sessionId: string;
}

export class JsonlTranscriptWriter implements TranscriptSink {
  readonly sessionId: string;
  readonly path: string;
  private handle: FileHandle;
  private sequence: number;
  private closed = false;

  private constructor(opts: TranscriptWriterOptions, handle: FileHandle, sequence: number) {
    this.path = opts.path;
    this.sessionId = opts.sessionId;
    this.handle = handle;
    this.sequence = sequence;
  }

  static async open(opts: TranscriptWriterOptions): Promise<JsonlTranscriptWriter> {
    await fs.promises.mkdir(path.dirname(opts.path), { recursive: true, mode: 0o700 });
    await fs.promises.chmod(path.dirname(opts.path), 0o700).catch(() => undefined);
    const handle = await fs.promises.open(opts.path, 'a+', 0o600);
    await handle.chmod(0o600).catch(() => undefined);
    try {
      const sequence = await recoverTail(handle);
      return new JsonlTranscriptWriter(opts, handle, sequence);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async append(events: NewTranscriptEvent[]): Promise<void> {
    if (this.closed) throw new Error('Transcript writer is closed');
    if (events.length === 0) return;
    const lines: string[] = [];
    let next = this.sequence;
    for (const event of events) {
      const record: KoanTranscriptEvent = {
        schema_version: 1,
        timestamp: event.timestamp,
        session_id: this.sessionId,
        sequence: ++next,
        ...(event.turn_id ? { turn_id: event.turn_id } : {}),
        type: event.type,
        payload: redactTranscriptValue(event.payload) as Record<string, unknown>,
      };
      lines.push(JSON.stringify(record));
    }
    await this.handle.appendFile(lines.join('\n') + '\n', 'utf8');
    this.sequence = next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

async function recoverTail(handle: FileHandle): Promise<number> {
  const stat = await handle.stat();
  if (stat.size === 0) return 0;
  const readSize = Math.min(stat.size, 64 * 1024);
  const buffer = Buffer.alloc(readSize);
  await handle.read(buffer, 0, readSize, stat.size - readSize);
  let tail = buffer.toString('utf8');

  if (!tail.endsWith('\n')) {
    const finalBreak = tail.lastIndexOf('\n');
    const fragment = tail.slice(finalBreak + 1);
    try {
      JSON.parse(fragment);
      await handle.appendFile('\n', 'utf8');
      tail += '\n';
    } catch {
      const truncateAt = stat.size - Buffer.byteLength(fragment, 'utf8');
      await handle.truncate(truncateAt);
      tail = finalBreak >= 0 ? tail.slice(0, finalBreak + 1) : '';
    }
  }

  const lines = tail.trimEnd().split('\n').filter(Boolean);
  if (lines.length === 0) return 0;
  let last: unknown;
  try {
    last = JSON.parse(lines[lines.length - 1]);
  } catch (error: any) {
    throw new Error(`Invalid transcript tail in ${handle.fd}: ${error.message}`);
  }
  const sequence = Number((last as any)?.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('Transcript tail has no valid sequence');
  }
  return sequence;
}
