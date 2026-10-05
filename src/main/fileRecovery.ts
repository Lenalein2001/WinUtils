import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, lstat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isMissingFile, writeJsonAtomically } from './atomicFile';
import { assertSafeSyncPath, identifySyncRoot, type SyncRootIdentity } from './fileSyncSafety';
import { moveFileSafely } from './safeMove';
import { handleFileOperation } from './handleFileOperations';
import type { FileRecoveryItem } from '../shared/fileSync';

interface Record extends FileRecoveryItem { version: 1; relativeBackup: string; root: string; identity: SyncRootIdentity; quarantineIdentity?: SyncRootIdentity }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);

export class FileRecovery {
  constructor(private readonly root: string) {}
  private get recordsPath(): string { return path.join(this.root, '.records'); }
  private recordPath(id: string): string {
    if (!validId(id)) throw new Error('Invalid recovery record.');
    return path.join(this.recordsPath, `${id}.json`);
  }
  private async read(id: string): Promise<Record> {
    const file = this.recordPath(id);
    const rootIdentity = await identifySyncRoot(this.root);
    await assertSafeSyncPath(this.root, rootIdentity, file);
    if ((await lstat(file)).size > 32768) throw new Error('Recovery record is too large.');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record;
    if (record.version !== 1 || record.id !== id || typeof record.originalPath !== 'string'
      || typeof record.relativeBackup !== 'string' || typeof record.root !== 'string' || !record.identity
      || !path.isAbsolute(record.root) || !path.isAbsolute(record.originalPath) || path.isAbsolute(record.relativeBackup)
      || typeof record.complete !== 'boolean' || typeof record.jobName !== 'string' || typeof record.runId !== 'string') {
      throw new Error('Invalid recovery record; original retained.');
    }
    await assertSafeSyncPath(this.root, rootIdentity, path.resolve(this.root, record.relativeBackup));
    Object.defineProperty(record, 'quarantineIdentity', { value: rootIdentity });
    return record;
  }
  async register(backup: string, original: string, root: string, jobName: string, runId: string): Promise<void> {
    if ((await this.ids()).length >= 10000) throw new Error('Recovery index is full. Purge completed copies before another sync run.');
    const recoveryIdentity = await identifySyncRoot(this.root);
    await assertSafeSyncPath(this.root, recoveryIdentity, this.recordsPath);
    await assertSafeSyncPath(this.root, recoveryIdentity, backup);
    await mkdir(this.recordsPath, { recursive: true });
    await assertSafeSyncPath(this.root, recoveryIdentity, this.recordsPath);
    const identity = await identifySyncRoot(root);
    await assertSafeSyncPath(root, identity, original);
    const record: Record = {
      version: 1, id: randomUUID(), runId, jobName, originalPath: original, createdAt: new Date().toISOString(),
      sizeBytes: (await lstat(original)).size, complete: false, collision: false,
      relativeBackup: path.relative(this.root, backup), root, identity,
    };
    await writeJsonAtomically(this.recordPath(record.id), record);
  }
  private async ids(): Promise<string[]> {
    try {
      const identity = await identifySyncRoot(this.root);
      await assertSafeSyncPath(this.root, identity, this.recordsPath);
      const files = await readdir(this.recordsPath);
      if (files.length > 10000) throw new Error('Recovery index exceeds 10000 records. Archive old versions before continuing.');
      return files.filter(file => file.endsWith('.json') && validId(file.slice(0, -5))).map(file => file.slice(0, -5));
    } catch (error) { if (isMissingFile(error)) return []; throw error; }
  }
  async list(): Promise<FileRecoveryItem[]> {
    const items: FileRecoveryItem[] = [];
    for (const id of await this.ids()) {
      const record = await this.read(id);
      try { await lstat(path.resolve(this.root, record.relativeBackup)); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      let collision = false;
      try { await lstat(record.originalPath); collision = true; } catch (error) { if (!isMissingFile(error)) throw error; }
      items.push({ id, runId: record.runId, jobName: record.jobName, originalPath: record.originalPath,
        createdAt: record.createdAt, sizeBytes: record.sizeBytes, complete: record.complete, collision });
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async completeRun(runId: string): Promise<void> {
    for (const id of await this.ids()) {
      const record = await this.read(id);
      if (record.runId === runId) await writeJsonAtomically(this.recordPath(id), { ...record, complete: true });
    }
  }
  async restore(id: string): Promise<void> {
    const record = await this.read(id);
    await assertSafeSyncPath(record.root, record.identity, record.originalPath);
    // Exclusive move refuses collisions and retains the recovery copy on failure.
    await moveFileSafely(path.resolve(this.root, record.relativeBackup), record.originalPath, undefined,
      [{ ...record.identity, path: record.root }, { ...record.quarantineIdentity!, path: this.root }]);
    await unlink(this.recordPath(id));
  }
  async purge(id: string): Promise<void> {
    const record = await this.read(id);
    if (!record.complete) throw new Error('This copy belongs to an incomplete transaction. Restore it before removing its recovery record.');
    const backup = path.resolve(this.root, record.relativeBackup);
    const info = await lstat(backup, { bigint: true });
    if (info.isSymbolicLink()) throw new Error('Recovery refuses reparse points.');
    if (await handleFileOperation('delete', backup, '', { device: String(info.dev), fileId: String(info.ino), modifiedNs: info.isFile() ? String(info.mtimeNs) : undefined }, [{ ...record.quarantineIdentity!, path: this.root }])) {
      await unlink(this.recordPath(id)); return;
    }
    if (info.isDirectory()) await rmdir(backup); // Never recursively remove an unexpected tree.
    else if (info.isFile()) await unlink(backup);
    else throw new Error('Unsupported recovery item.');
    await unlink(this.recordPath(id));
  }
}
