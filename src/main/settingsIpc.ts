import { handleTrustedIpc } from './ipcSecurity';
import { SerialTaskQueue } from './atomicFile';
import type { AppSettings } from '../shared/settings';
import { AppSettingsStore } from './appSettingsStore';
import { applyAppLoginItemSettings, getAppLaunchAtLogin } from './loginItem';

export function registerSettingsIpcHandlers(settingsStore: AppSettingsStore): void {
  const updates = new SerialTaskQueue();
  handleTrustedIpc('settings:get', async (): Promise<AppSettings> => ({
    ...await settingsStore.load(), launchAtLogin: getAppLaunchAtLogin(),
  }));
  handleTrustedIpc('settings:update', (_event, patch: Partial<AppSettings>): Promise<AppSettings> => updates.run(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings update.');
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
  }));
}
