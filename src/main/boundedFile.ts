import { createReadStream } from 'node:fs';

/** Read a selected import without allocating an unbounded whole-file buffer. */
export async function readBoundedUtf8(filePath: string, maximumBytes: number): Promise<string> {
  return (await readBoundedBytes(filePath, maximumBytes)).toString('utf8');
}

export async function readBoundedBytes(filePath: string, maximumBytes: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error(`Import exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB file limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}
