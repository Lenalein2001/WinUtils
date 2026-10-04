import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RenameFileIdentity, RenameTransaction, RenameTransactionOperation } from '../shared/renamer';
import { isMissingFile, writeJsonAtomically } from './atomicFile';

interface PlannedRename extends RenameTransactionOperation {
  identity: RenameFileIdentity;
  tempPath: string;
}

export interface RenameJournal {
  version: 1;
  phase: 'moving' | 'committed';
  transaction: RenameTransaction;
  undo: boolean;
  operations: PlannedRename[];
}

type CommitRename = (journal: RenameJournal) => Promise<void>;

/** A flushed pre-mutation journal survives failure between any pair of renames. */
export class RenameTransactionRunner {
  constructor(private readonly journalPath: string, private readonly commit: CommitRename) {}

  async recover(): Promise<void> {
    let journal: RenameJournal;
    try {
      journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as RenameJournal;
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new Error(`Rename recovery journal could not be read; it has been preserved: ${error}`);
    }
    validateJournal(journal);
    if (journal.phase === 'committed') {
      await this.commit(journal);
    } else {
      await this.rollback(journal);
    }
    await unlink(this.journalPath);
  }

  async execute(transaction: RenameTransaction, operations: RenameTransactionOperation[], undo: boolean): Promise<void> {
    const sources = new Set(operations.map(operation => pathKey(operation.fromPath)));
    const planned: PlannedRename[] = [];
    for (const operation of operations) {
      const identity = await readIdentity(operation.fromPath);
      if (operation.identity && !sameIdentity(operation.identity, identity)) {
        throw new Error(`File was replaced since the rename transaction: ${operation.fromPath}`);
      }
      if (await pathExists(operation.toPath) && !sources.has(pathKey(operation.toPath))) {
        throw new Error(`Target already exists; refusing to replace it: ${operation.toPath}`);
      }
      planned.push({
        ...operation,
        identity,
        tempPath: path.join(path.dirname(operation.fromPath), `.winutils-renaming-${randomUUID()}.tmp`),
      });
    }
    if (!undo) {
      transaction.operations = transaction.operations.map((operation, index) => ({ ...operation, identity: planned[index].identity }));
    }
    const journal: RenameJournal = { version: 1, phase: 'moving', transaction, undo, operations: planned };
    validateJournal(journal);
    await writeJsonAtomically(this.journalPath, journal);
    try {
      for (const operation of planned) {
        await assertIdentity(operation.fromPath, operation.identity);
        await renameWithoutReplacement(operation.fromPath, operation.tempPath);
      }
      for (const operation of planned) {
        await assertIdentity(operation.tempPath, operation.identity);
        await renameWithoutReplacement(operation.tempPath, operation.toPath);
      }
      journal.phase = 'committed';
      await writeJsonAtomically(this.journalPath, journal);
    } catch (error) {
      try {
        await this.rollback(journal);
        await unlink(this.journalPath);
      } catch (recoveryError) {
        throw new Error(`Rename failed: ${error}. Recovery is incomplete; journal preserved at ${this.journalPath}. ${recoveryError}`);
      }
      throw new Error(`Rename failed; all transaction files were restored: ${error}`);
    }
    // Once committed on disk, a history write failure must not reverse a successful
    // rename. The retained journal completes history publication on the next access.
    await this.commit(journal);
    await unlink(this.journalPath);
  }

  private async rollback(journal: RenameJournal): Promise<void> {
    // Locate every transaction-owned object before moving anything. Never infer
    // ownership from a filename; a user may have recreated it after a crash.
    const locations = await Promise.all(journal.operations.map(async operation => {
      for (const candidate of [operation.tempPath, operation.toPath, operation.fromPath]) {
        try {
          if (sameIdentity(operation.identity, await readIdentity(candidate))) return candidate;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      throw new Error(`Cannot find transaction file; inspect ${operation.fromPath}, ${operation.tempPath}, ${operation.toPath}`);
    }));

    // Evacuate all targets first, so cycles and case-only changes are reversible.
    for (let index = 0; index < journal.operations.length; index += 1) {
      const operation = journal.operations[index];
      if (pathKey(locations[index]) === pathKey(operation.tempPath)) continue;
      await assertIdentity(locations[index], operation.identity);
      await renameWithoutReplacement(locations[index], operation.tempPath);
    }
    for (const operation of journal.operations) {
      await assertIdentity(operation.tempPath, operation.identity);
      await renameWithoutReplacement(operation.tempPath, operation.fromPath);
    }
  }
}

async function readIdentity(filePath: string): Promise<RenameFileIdentity> {
  const info = await lstat(filePath, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error(`Renaming links or special filesystem objects is not supported: ${filePath}`);
  }
  if (info.ino === 0n) throw new Error(`This filesystem does not provide a stable file ID for recovery: ${filePath}`);
  // NTFS filename tunneling can change creation time during a rename. File IDs
  // remain stable; bigint avoids rounding 64-bit IDs into the same JS number.
  return { device: String(info.dev), inode: String(info.ino) };
}

function sameIdentity(left: RenameFileIdentity, right: RenameFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function assertIdentity(filePath: string, identity: RenameFileIdentity): Promise<void> {
  if (!sameIdentity(identity, await readIdentity(filePath))) throw new Error(`File changed identity: ${filePath}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function renameWithoutReplacement(sourcePath: string, destinationPath: string): Promise<void> {
  if (await pathExists(destinationPath)) throw new Error(`Recovery/rename target already exists: ${destinationPath}`);
  await rename(sourcePath, destinationPath);
}

function pathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function validateJournal(journal: RenameJournal): void {
  if (!journal || journal.version !== 1 || !['moving', 'committed'].includes(journal.phase)
    || typeof journal.undo !== 'boolean' || typeof journal.transaction?.id !== 'string'
    || !Array.isArray(journal.transaction.operations) || !Array.isArray(journal.operations)
    || !journal.operations.length || journal.operations.length !== journal.transaction.operations.length) {
    throw new Error('Invalid rename recovery journal; preserved for inspection.');
  }
  const sourcePaths = new Set<string>();
  const targetPaths = new Set<string>();
  const temporaryPaths = new Set<string>();
  for (const operation of journal.operations) {
    if (![operation.fromPath, operation.toPath, operation.tempPath].every(value => typeof value === 'string' && path.isAbsolute(value))
      || pathKey(path.dirname(operation.fromPath)) !== pathKey(path.dirname(operation.toPath))
      || pathKey(path.dirname(operation.fromPath)) !== pathKey(path.dirname(operation.tempPath))
      || !/^\.winutils-renaming-[0-9a-f-]+\.tmp$/i.test(path.basename(operation.tempPath))
      || !operation.identity || ![operation.identity.device, operation.identity.inode].every(value => typeof value === 'string' && /^\d+$/.test(value))
      || sourcePaths.has(pathKey(operation.fromPath)) || targetPaths.has(pathKey(operation.toPath))
      || temporaryPaths.has(pathKey(operation.tempPath))) {
      throw new Error('Invalid rename recovery operation; journal preserved for inspection.');
    }
    sourcePaths.add(pathKey(operation.fromPath));
    targetPaths.add(pathKey(operation.toPath));
    temporaryPaths.add(pathKey(operation.tempPath));
  }
  if ([...temporaryPaths].some(filePath => sourcePaths.has(filePath) || targetPaths.has(filePath))) {
    throw new Error('Rename recovery temporary paths overlap batch paths.');
  }
}
