import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileSyncEntryInfo } from '../shared/fileSync';
import { isMissingFile } from './atomicFile';

export interface SyncRootIdentity { canonicalPath: string; device: string; fileId: string }
export async function identifySyncRoot(rootPath: string): Promise<SyncRootIdentity> {
  const info = await lstat(rootPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe sync root: ${rootPath}`);
  return { canonicalPath: await realpath(rootPath), device: String(info.dev), fileId: String(info.ino) };
}

export async function assertSafeSyncPath(rootPath: string, identity: SyncRootIdentity, targetPath: string): Promise<void> {
  const root = path.resolve(rootPath);
  const relative = path.relative(root, path.resolve(targetPath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sync root: ${targetPath}`);
  }
  const current = await identifySyncRoot(root);
  if (current.canonicalPath.toLowerCase() !== identity.canonicalPath.toLowerCase()
    || current.device !== identity.device || current.fileId !== identity.fileId) {
    throw new Error(`Sync root changed since Analyze: ${root}`);
  }
  let candidate = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    candidate = path.join(candidate, segments[index]);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) {
        throw new Error(`Symbolic link, junction, or invalid parent blocks sync: ${candidate}`);
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

export async function assertEntryUnchanged(targetPath: string, expected?: FileSyncEntryInfo): Promise<void> {
  let info;
  try { info = await lstat(targetPath, { bigint: true }); } catch (error) {
    if (!expected && isMissingFile(error)) return;
    throw new Error(`File became unavailable since Analyze: ${targetPath}. ${error}`);
  }
  if (!expected) throw new Error(`A new target appeared since Analyze; refusing to replace it: ${targetPath}`);
  if (info.isSymbolicLink() || (expected.kind === 'file' ? !info.isFile() : !info.isDirectory())
    || (expected.kind === 'file' && (Number(info.size) !== expected.size || info.mtime.toISOString() !== expected.modifiedAt))
    || (expected.version && (String(info.dev) !== expected.version.device
      || String(info.ino) !== expected.version.fileId || (expected.kind === 'file' && String(info.mtimeNs) !== expected.version.modifiedNs)))) {
    throw new Error(`File changed since Analyze; re-analyze before syncing: ${targetPath}`);
  }
}
