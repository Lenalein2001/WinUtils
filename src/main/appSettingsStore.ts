import { SerialTaskQueue, writeJsonAtomically } from './atomicFile';
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultAppSettings, type AppSettings, type AppTheme } from '../shared/settings';

function normalizeTheme(value: unknown): AppTheme {
  if (value === 'sable-night' || value === 'sable-ember' || value === 'winutils-blue') {
    return value;
  }
  return defaultAppSettings.theme;
}

export class AppSettingsStore {
  private readonly saveQueue = new SerialTaskQueue();
  private loading: Promise<AppSettings> | null = null;
  private _settings: AppSettings | null = null;

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  async load(): Promise<AppSettings> {
    if (this._settings) return this._settings;
    if (!this.loading) this.loading = this.loadInternal().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async loadInternal(): Promise<AppSettings> {
    if (this._settings) return this._settings;

    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    if (!existsSync(this.filePath)) {
      this._settings = { ...defaultAppSettings };
      await this.save(this._settings);
      return this._settings;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings document.');
      for (const key of ['launchAtLogin', 'startMinimized', 'minimizeToTray', 'closeToTray'] as const) {
        if (parsed[key] !== undefined && typeof parsed[key] !== 'boolean') throw new Error(`Invalid setting: ${key}.`);
      }
      this._settings = {
        launchAtLogin: parsed.launchAtLogin ?? defaultAppSettings.launchAtLogin,
        startMinimized: parsed.startMinimized ?? defaultAppSettings.startMinimized,
        minimizeToTray: parsed.minimizeToTray ?? defaultAppSettings.minimizeToTray,
        closeToTray: parsed.closeToTray ?? defaultAppSettings.closeToTray,
        theme: normalizeTheme(parsed.theme),
      };
      return this._settings;
    } catch (error) {
      this._settings = null;
      throw new Error(`Settings could not be read; the original file was preserved. ${String(error)}`);
    }
  }

  get(): AppSettings {
    return this._settings ?? { ...defaultAppSettings };
  }

  async save(next: AppSettings): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const snapshot = structuredClone(next);
    await this.saveQueue.run(() => writeJsonAtomically(this.filePath, snapshot));
    this._settings = snapshot;
  }
}
