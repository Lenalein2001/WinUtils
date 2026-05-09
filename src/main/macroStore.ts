import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MacroConfig, MacroProfile, MacroState } from '../shared/macro';

function defaultConfig(): MacroConfig {
  return {
    activeProfile: 'Default',
    profiles: [
      {
        name: 'Default',
        folders: [],
        macros: [],
      },
    ],
    recordToggleHotkey: 'Ctrl+R',
  };
}

export class MacroStore {
  private get configPath(): string {
    return path.join(app.getPath('userData'), 'macros.json');
  }

  private get configDir(): string {
    return path.dirname(this.configPath);
  }

  private _config: MacroConfig | null = null;

  async load(): Promise<MacroConfig> {
    if (this._config) return this._config;

    await mkdir(this.configDir, { recursive: true });

    if (!existsSync(this.configPath)) {
      this._config = defaultConfig();
      await this.save();
      return this._config;
    }

    for (const tryPath of [this.configPath, this.configPath + '.bak']) {
      if (!existsSync(tryPath)) continue;
      try {
        const raw = await readFile(tryPath, 'utf8');
        const parsed = JSON.parse(raw) as MacroConfig;
        if (parsed && Array.isArray(parsed.profiles)) {
          this._config = parsed;
          return this._config;
        }
      } catch {
        // try backup
      }
    }

    this._config = defaultConfig();
    await this.save();
    return this._config;
  }

  async save(): Promise<void> {
    if (!this._config) return;
    await mkdir(this.configDir, { recursive: true });
    const tmp = this.configPath + '.tmp';
    await writeFile(tmp, JSON.stringify(this._config, null, 2), 'utf8');
    if (existsSync(this.configPath)) {
      await writeFile(this.configPath + '.bak', await readFile(this.configPath, 'utf8'), 'utf8');
    }
    await writeFile(this.configPath, await readFile(tmp, 'utf8'), 'utf8');
    try { await import('node:fs/promises').then(fs => fs.unlink(tmp)); } catch { /* ignore */ }
  }

  getActiveProfile(): MacroProfile {
    const cfg = this._config!;
    return cfg.profiles.find(p => p.name === cfg.activeProfile) ?? cfg.profiles[0];
  }

  buildState(): MacroState {
    const cfg = this._config!;
    const profile = this.getActiveProfile();
    const allMacros = [
      ...profile.macros,
      ...profile.folders.flatMap(f => f.macros),
    ];
    return { config: cfg, allMacros, activeProfile: profile };
  }
}
