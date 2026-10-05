import { app } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isMissingFile, SerialTaskQueue, writeJsonAtomically } from './atomicFile';
import { normalizeMacroPlayback, type Macro, type MacroConfig, type MacroProfile, type MacroState } from '../shared/macro';

function normalizeStoredMacro(macro: Macro): Macro {
  return { ...macro, playback: normalizeMacroPlayback(macro.playback) };
}

function normalizeStoredProfile(profile: MacroProfile): MacroProfile {
  return {
    ...profile,
    macros: profile.macros.map(normalizeStoredMacro),
    folders: profile.folders.map(folder => ({
      ...folder,
      macros: folder.macros.map(normalizeStoredMacro),
    })),
  };
}

function normalizeStoredConfig(config: MacroConfig): MacroConfig {
  return {
    ...config,
    profiles: config.profiles.map(normalizeStoredProfile),
    recordToggleHotkey: config.recordToggleHotkey || 'Ctrl+R',
  };
}

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
  private readonly saveQueue = new SerialTaskQueue();
  private loading: Promise<MacroConfig> | null = null;
  private get configPath(): string {
    return path.join(app.getPath('userData'), 'macros.json');
  }

  private get configDir(): string {
    return path.dirname(this.configPath);
  }

  private _config: MacroConfig | null = null;

  async load(): Promise<MacroConfig> {
    if (this._config) return this._config!;
    if (!this.loading) this.loading = this.loadInternal().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async loadInternal(): Promise<MacroConfig> {
    await mkdir(this.configDir, { recursive: true });
    let invalid = false;
    for (const candidate of [this.configPath, this.configPath + '.bak']) {
      let raw: string;
      try { raw = await readFile(candidate, 'utf8'); }
      catch (error) { if (isMissingFile(error)) continue; throw error; }
      try {
        const parsed = JSON.parse(raw) as MacroConfig;
        if (!Array.isArray(parsed.profiles) || !parsed.profiles.length) throw new Error('No valid macro profiles.');
        const normalized = normalizeStoredConfig(parsed);
        this._config = normalized;
        return normalized;
      } catch { invalid = true; }
    }
    if (invalid) throw new Error('Macro configuration and backup could not be read. Original files were preserved.');
    this._config = defaultConfig();
    await this.save();
    return this._config;
  }

  async save(): Promise<void> {
    if (!this._config) return;
    const snapshot = structuredClone(this._config);
    await this.saveQueue.run(async () => {
      let previous: unknown;
      try {
        const raw = await readFile(this.configPath, 'utf8');
        try { previous = normalizeStoredConfig(JSON.parse(raw)); } catch { /* Preserve a good backup when the primary is damaged. */ }
      } catch (error) { if (!isMissingFile(error)) throw error; }
      if (previous) await writeJsonAtomically(this.configPath + '.bak', previous);
      await writeJsonAtomically(this.configPath, snapshot);
    });
  }

  async drain(): Promise<void> { await this.saveQueue.drain(); }

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
