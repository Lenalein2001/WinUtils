import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export function writeJsonAtomicallySync(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(temporaryPath, 'wx');
    try { writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8'); fsyncSync(handle); }
    finally { closeSync(handle); }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* The previous file remains intact. */ }
    throw error;
  }
}

/** Publish a complete, flushed file without truncating the previous version. */
export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await writeBytesAtomically(filePath, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

export async function writeBytesAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Serializes mutations, including after a rejected operation. */
export class SerialTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}
