import { safeStorage } from 'electron';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readBoundedBytes } from './boundedFile';
import { isMissingFile, writeBytesAtomically } from './atomicFile';

const MAGIC = Buffer.from('WinUtilsClipboardVault:1\0');
export class ClipboardVault {
  private key: Buffer | null = null;
  constructor(private readonly keyPath: string) {}
  available(): boolean { return Boolean(safeStorage?.isEncryptionAvailable()); }
  encrypted(bytes: Buffer): boolean { return bytes.subarray(0, MAGIC.length).equals(MAGIC); }
  private async getKey(create = false): Promise<Buffer> {
    if (this.key) return this.key;
    if (!this.available()) throw new Error('Windows profile encryption is unavailable. Clipboard files were preserved.');
    try {
      const wrapped = await readBoundedBytes(this.keyPath, 8192);
      const key = Buffer.from(safeStorage.decryptString(wrapped), 'base64');
      if (key.length !== 32) throw new Error('Invalid clipboard encryption key.');
      this.key = key;
    } catch (error) {
      if (!create || !isMissingFile(error)) throw error;
      const key = randomBytes(32);
      await writeBytesAtomically(this.keyPath, safeStorage.encryptString(key.toString('base64')));
      this.key = key;
    }
    return this.key;
  }
  async seal(bytes: Buffer): Promise<Buffer> {
    const key = await this.getKey(true), nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const payload = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), payload]);
  }
  async open(bytes: Buffer): Promise<Buffer> {
    if (!this.encrypted(bytes)) return bytes;
    if (bytes.length < MAGIC.length + 28) throw new Error('Truncated encrypted clipboard file.');
    const key = await this.getKey();
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
    return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()]);
  }
}
