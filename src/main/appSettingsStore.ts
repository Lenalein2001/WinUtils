import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultAppSettings, type AppSettings, type AppTheme } from '../shared/settings';

function normalizeTheme(value: unknown): AppTheme {
  if (value === 'sable-night' || value === 'sable-ember' || value === 'winutils-blue') {
    return value;
  }
  return defaultAppSettings.theme;
}

export class AppSettingsStore {
  private _settings: AppSettings | null = null;

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  async load(): Promise<AppSettings> {
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
      this._settings = {
        launchAtLogin: Boolean(parsed.launchAtLogin),
        startMinimized: Boolean(parsed.startMinimized),
        minimizeToTray: Boolean(parsed.minimizeToTray),
        closeToTray: Boolean(parsed.closeToTray),
        theme: normalizeTheme(parsed.theme),
      };
      return this._settings;
    } catch {
      this._settings = { ...defaultAppSettings };
      await this.save(this._settings);
      return this._settings;
    }
  }

  get(): AppSettings {
    return this._settings ?? { ...defaultAppSettings };
  }

  async save(next: AppSettings): Promise<void> {
    this._settings = next;
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8');
  }
}