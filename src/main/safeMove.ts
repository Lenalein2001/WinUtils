import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, rmdir, unlink, utimes } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** EXDEV fallback commits a flushed, verified copy before removing its source. */
export async function moveFileSafely(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try { await lstat(target); throw new Error(`Move destination already exists: ${target}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await rename(source, target); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  const original = await lstat(source, { bigint: true });
  if (original.isSymbolicLink()) throw new Error('Cross-volume moves refuse reparse points.');
  const unchanged = async (): Promise<void> => {
    const current = await lstat(source, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeNs !== original.mtimeNs) {
      throw new Error(`Source changed during cross-volume move; source retained: ${source}`);
    }
  };
  if (original.isDirectory()) {
    if ((await readdir(source)).length) throw new Error('Cross-volume directory moves require an empty directory.');
    await unchanged();
    await mkdir(target); // Exclusive; never merge unrelated directories.
    try { await unchanged(); await rmdir(source); }
    catch (error) { await rmdir(target).catch(() => undefined); throw error; }
    return;
  }
  if (!original.isFile()) throw new Error('Only regular files can be moved across volumes.');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.winutils-${randomUUID()}.tmp`);
  let published = false;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await unchanged();
    if (await digest(source) !== await digest(temporary)) throw new Error('Cross-volume copy verification failed.');
    await utimes(temporary, Number(original.atimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
    const staged = await open(temporary, 'r+');
    try { await staged.sync(); } finally { await staged.close(); }
    // COPYFILE_EXCL also works on destinations that do not support hard links.
    await copyFile(temporary, target, constants.COPYFILE_EXCL);
    published = true;
    await utimes(target, Number(original.atimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
    const committed = await open(target, 'r+');
    try { await committed.sync(); } finally { await committed.close(); }
    await unchanged();
    await unlink(source);
  } catch (error) {
    if (published) throw new Error(`Move was not completed; verified recovery copy retained at ${target}. ${String(error)}`);
    throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
}
