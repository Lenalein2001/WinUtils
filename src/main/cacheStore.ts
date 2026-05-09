import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DisabledStartupRecord, StartupCacheFile } from '../shared/startup';

const CACHE_FILE_NAME = 'startup-cache.json';
const DISABLED_STARTUP_DIR = 'disabled-startup-items';

export class StartupCacheStore {
  private initialized = false;

  private get cacheDir(): string {
    return path.join(app.getPath('userData'), 'startup-manager');
  }

  private get cacheFile(): string {
    return path.join(this.cacheDir, CACHE_FILE_NAME);
  }

  private get disabledItemsDir(): string {
    return path.join(this.cacheDir, DISABLED_STARTUP_DIR);
  }

  async ensureReady(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.disabledItemsDir, { recursive: true });

    try {
      await readFile(this.cacheFile, 'utf8');
    } catch {
      await writeFile(this.cacheFile, JSON.stringify({ version: 1, disabledEntries: [] }, null, 2), 'utf8');
    }

    this.initialized = true;
  }

  async getDisabledItemsDir(): Promise<string> {
    await this.ensureReady();
    return this.disabledItemsDir;
  }

  async read(): Promise<StartupCacheFile> {
    await this.ensureReady();

    try {
      const raw = await readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(raw) as StartupCacheFile;

      return {
        version: 1,
        disabledEntries: Array.isArray(parsed.disabledEntries) ? parsed.disabledEntries : [],
      };
    } catch {
      return { version: 1, disabledEntries: [] };
    }
  }

  async write(cache: StartupCacheFile): Promise<void> {
    await this.ensureReady();
    await writeFile(this.cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  }

  async upsertDisabledEntry(record: DisabledStartupRecord): Promise<void> {
    const cache = await this.read();
    const existingIndex = cache.disabledEntries.findIndex((entry) => entry.id === record.id);

    if (existingIndex >= 0) {
      cache.disabledEntries[existingIndex] = record;
    } else {
      cache.disabledEntries.push(record);
    }

    await this.write(cache);
  }

  async removeDisabledEntry(id: string): Promise<DisabledStartupRecord | undefined> {
    const cache = await this.read();
    const record = cache.disabledEntries.find((entry) => entry.id === id);

    if (!record) {
      return undefined;
    }

    cache.disabledEntries = cache.disabledEntries.filter((entry) => entry.id !== id);
    await this.write(cache);
    return record;
  }

  async deleteDisabledEntry(id: string): Promise<DisabledStartupRecord | undefined> {
    const record = await this.removeDisabledEntry(id);

    if (record?.kind === 'startup-folder') {
      await rm(record.cachedPath, { force: true });
    }

    return record;
  }
}
