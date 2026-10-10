import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const requireImage = createRequire(import.meta.url);
const MAX_PNG_BYTES = 16 * 1024 * 1024;
let activeWorkers = 0;

// Electron's Windows bitmap is premultiplied BGRA. PNG stores straight RGBA.
// Compression and hashing run outside the event loop that dispatches app work.
const source = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { createHash } = require('node:crypto');
  try {
    const { PNG } = require(workerData.codecPath);
    const pixels = Buffer.from(workerData.pixels);
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2], a = pixels[i + 3];
      pixels[i] = a ? Math.min(255, Math.round(r * 255 / a)) : 0;
      pixels[i + 1] = a ? Math.min(255, Math.round(g * 255 / a)) : 0;
      pixels[i + 2] = a ? Math.min(255, Math.round(b * 255 / a)) : 0;
    }
    const png = PNG.sync.write({ width: workerData.width, height: workerData.height, data: pixels });
    if (png.length > workerData.maxBytes) {
      parentPort.postMessage({ oversized: true });
    } else {
      const hash = createHash('sha256').update('image').update(String.fromCharCode(0)).update(png).digest('hex');
      const output = Uint8Array.from(png);
      parentPort.postMessage({ png: output, hash }, [output.buffer]);
    }
  } catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
`;

export async function encodeClipboardImage(bitmap: Buffer, width: number, height: number, signal?: AbortSignal): Promise<{ png: Buffer; hash: string } | null> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width * height > 16_000_000 || bitmap.length !== width * height * 4) {
    throw new Error('Clipboard image exceeds its bitmap limits.');
  }
  if (signal?.aborted) throw new Error('Clipboard image encoding cancelled.');
  if (activeWorkers >= 2) throw new Error('Clipboard image workers are busy.');
  // Own the transferred allocation; never detach Electron's backing bitmap.
  const pixels = new Uint8Array(bitmap.length);
  pixels.set(bitmap);
  const worker = new Worker(source, {
    eval: true,
    workerData: { pixels: pixels.buffer, width, height, maxBytes: MAX_PNG_BYTES, codecPath: requireImage.resolve('pngjs') },
    transferList: [pixels.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 2 },
  });
  activeWorkers++;
  worker.once('exit', () => { activeWorkers--; });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { png: Buffer; hash: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result ?? null);
    };
    const abort = (): void => finish(new Error('Clipboard image encoding cancelled.'));
    const timer = setTimeout(() => finish(new Error('Clipboard image encoding timed out.')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', result => {
      if (result.error) finish(new Error(result.error));
      else if (result.oversized === true) finish(undefined, null);
      else if (!ArrayBuffer.isView(result.png) || !result.png.length || result.png.length > MAX_PNG_BYTES
        || typeof result.hash !== 'string' || !/^[a-f0-9]{64}$/.test(result.hash)) {
        finish(new Error('Invalid clipboard image worker response.'));
      } else finish(undefined, { png: Buffer.from(result.png.buffer, result.png.byteOffset, result.png.byteLength), hash: result.hash });
    });
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', code => finish(new Error(`Clipboard image worker exited before returning a result (${code}).`)));
  });
}

