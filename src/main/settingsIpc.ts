import { ipcMain } from 'electron';
import type { AppSettings } from '../shared/settings';
import { AppSettingsStore } from './appSettingsStore';
import { applyAppLoginItemSettings, getAppLaunchAtLogin } from './loginItem';

export function registerSettingsIpcHandlers(settingsStore: AppSettingsStore): void {
  ipcMain.handle('settings:get', async (): Promise<AppSettings> => {
    const stored = await settingsStore.load();
    const launchAtLogin = getAppLaunchAtLogin();

    if (stored.launchAtLogin !== launchAtLogin) {
      await settingsStore.save({ ...stored, launchAtLogin });
    }

    return {
      launchAtLogin,
      startMinimized: stored.startMinimized,
      minimizeToTray: stored.minimizeToTray,
      closeToTray: stored.closeToTray,
    };
  });

  ipcMain.handle('settings:update', async (_event, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const current = await settingsStore.load();
    const next: AppSettings = {
      launchAtLogin: patch.launchAtLogin ?? current.launchAtLogin,
      startMinimized: patch.startMinimized ?? current.startMinimized,
      minimizeToTray: patch.minimizeToTray ?? current.minimizeToTray,
      closeToTray: patch.closeToTray ?? current.closeToTray,
    };

    await settingsStore.save(next);
    applyAppLoginItemSettings(next);

    return next;
  });
}
