import { app } from 'electron';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DisabledStartupRecord, StartupCacheFile } from '../shared/startup';
import { isMissingFile, SerialTaskQueue, writeJsonAtomically } from './atomicFile';

const CACHE_FILE_NAME = 'startup-cache.json';
const DISABLED_STARTUP_DIR = 'disabled-startup-items';

export class StartupCacheStore {
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private readonly mutations = new SerialTaskQueue();

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
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        await mkdir(this.cacheDir, { recursive: true });
        await mkdir(this.disabledItemsDir, { recursive: true });
        try {
          await readFile(this.cacheFile, 'utf8');
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          await writeJsonAtomically(this.cacheFile, { version: 1, disabledEntries: [] });
        }
        this.initialized = true;
      })().finally(() => { this.initialization = null; });
    }
    await this.initialization;
  }

  async getDisabledItemsDir(): Promise<string> {
    await this.ensureReady();
    return this.disabledItemsDir;
  }

  async read(): Promise<StartupCacheFile> {
    await this.ensureReady();

    const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as StartupCacheFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.disabledEntries)
      || !parsed.disabledEntries.every(isDisabledRecord)) {
      throw new Error('Startup restore cache is invalid. The original file has been preserved.');
    }
    return parsed;
  }

  async write(cache: StartupCacheFile): Promise<void> {
    await this.mutations.run(async () => {
      await this.ensureReady();
      await writeJsonAtomically(this.cacheFile, cache);
    });
  }

  async upsertDisabledEntry(record: DisabledStartupRecord): Promise<void> {
    await this.mutations.run(async () => {
      const cache = await this.read();
      const existingIndex = cache.disabledEntries.findIndex((entry) => entry.id === record.id);
      if (existingIndex >= 0) {
        cache.disabledEntries[existingIndex] = record;
      } else {
        cache.disabledEntries.push(record);
      }
      await writeJsonAtomically(this.cacheFile, cache);
    });
  }

  async removeDisabledEntry(id: string): Promise<DisabledStartupRecord | undefined> {
    return this.mutations.run(() => this.removeRecord(id));
  }

  private async removeRecord(id: string): Promise<DisabledStartupRecord | undefined> {
    const cache = await this.read();
    const record = cache.disabledEntries.find((entry) => entry.id === id);

    if (!record) {
      return undefined;
    }

    cache.disabledEntries = cache.disabledEntries.filter((entry) => entry.id !== id);
    await writeJsonAtomically(this.cacheFile, cache);
    return record;
  }

  async deleteDisabledEntry(id: string): Promise<DisabledStartupRecord | undefined> {
    return this.mutations.run(async () => {
      const record = (await this.read()).disabledEntries.find(entry => entry.id === id);
      if (record?.kind === 'startup-folder') {
        await rm(record.cachedPath, { force: true });
      }
      return this.removeRecord(id);
    });
  }
}

function isDisabledRecord(value: unknown): value is DisabledStartupRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const common = ['id', 'name', 'command', 'executablePath', 'arguments', 'location', 'disabledAt'];
  if (!common.every(key => typeof record[key] === 'string')
    || !['current-user', 'all-users'].includes(String(record.scope))) return false;
  if (record.kind === 'registry') {
    return ['HKCU', 'HKLM'].includes(String(record.registryHive))
      && ['registryPath', 'valueName', 'regType'].every(key => typeof record[key] === 'string');
  }
  return record.kind === 'startup-folder'
    && typeof record.originalPath === 'string' && typeof record.cachedPath === 'string';
}
