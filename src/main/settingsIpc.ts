import { handleTrustedIpc } from './ipcSecurity';
import { SerialTaskQueue } from './atomicFile';
import { defaultAppSettings, type AppSettings } from '../shared/settings';
import { dialog } from 'electron';
import { readBoundedUtf8 } from './boundedFile';
import { writeJsonAtomically } from './atomicFile';
import { AppSettingsStore } from './appSettingsStore';
import { applyAppLoginItemSettings, getAppLaunchAtLogin } from './loginItem';

export function registerSettingsIpcHandlers(settingsStore: AppSettingsStore): void {
  const updates = new SerialTaskQueue();
  handleTrustedIpc('settings:get', async (): Promise<AppSettings> => ({
    ...await settingsStore.load(), launchAtLogin: getAppLaunchAtLogin(),
  }));
  const update = (patch: Partial<AppSettings>): Promise<AppSettings> => updates.run(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings update.');
    if (Object.keys(patch).some(key => !Object.hasOwn(defaultAppSettings, key))) throw new Error('Unknown app setting.');
    for (const key of ['launchAtLogin', 'startMinimized', 'minimizeToTray', 'closeToTray'] as const) {
      if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('Invalid setting: ' + key);
    }
    if (patch.theme !== undefined && !['sable-night', 'sable-ember', 'winutils-blue'].includes(patch.theme)) throw new Error('Invalid theme.');
    const current = { ...await settingsStore.load(), launchAtLogin: getAppLaunchAtLogin() };
    const next: AppSettings = {
      launchAtLogin: patch.launchAtLogin ?? current.launchAtLogin,
      startMinimized: patch.startMinimized ?? current.startMinimized,
      minimizeToTray: patch.minimizeToTray ?? current.minimizeToTray,
      closeToTray: patch.closeToTray ?? current.closeToTray,
      theme: patch.theme ?? current.theme,
    };
    try {
      applyAppLoginItemSettings(next);
      await settingsStore.save(next);
    } catch (error) {
      try { applyAppLoginItemSettings(current); } catch (restoreError) {
        throw new Error('Settings failed and Windows login registration could not be restored. ' + String(restoreError));
      }
      throw error;
    }
    return next;
  });
  handleTrustedIpc('settings:update', (_event, patch: Partial<AppSettings>) => update(patch));
  handleTrustedIpc('settings:reset', () => update({ ...defaultAppSettings }));
  handleTrustedIpc('settings:export', async () => {
    const selected = await dialog.showSaveDialog({ defaultPath: 'WinUtils-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return false;
    const settings = { ...await settingsStore.load(), launchAtLogin: getAppLaunchAtLogin() };
    await writeJsonAtomically(selected.filePath, { product: 'WinUtils', version: 1, settings });
    return true;
  });
  handleTrustedIpc('settings:importPreview', async () => {
    const selected = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const imported = JSON.parse(await readBoundedUtf8(selected.filePaths[0], 65536)) as { product?: unknown; version?: unknown; settings?: unknown };
    if (!imported || imported.product !== 'WinUtils' || imported.version !== 1 || !imported.settings || typeof imported.settings !== 'object') throw new Error('Invalid WinUtils settings export.');
    const settings = imported.settings as AppSettings;
    if (Object.keys(settings).length !== Object.keys(defaultAppSettings).length
      || Object.keys(defaultAppSettings).some(key => !Object.hasOwn(settings, key))
      || ['launchAtLogin', 'startMinimized', 'minimizeToTray', 'closeToTray'].some(key => typeof settings[key as keyof AppSettings] !== 'boolean')
      || !['sable-night', 'sable-ember', 'winutils-blue'].includes(settings.theme)) throw new Error('Invalid imported app settings.');
    return settings;
  });
}
