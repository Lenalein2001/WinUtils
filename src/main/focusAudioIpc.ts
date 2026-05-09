import { ipcMain } from 'electron';
import type { FocusAudioManager } from './focusAudioManager';

export function registerFocusAudioIpcHandlers(manager: FocusAudioManager): void {
  ipcMain.handle('focusAudio:getState', async () => {
    const activeAudioApps = manager.getCachedActiveAudioApps();
    const config = manager.getConfig();
    return { ...config, activeAudioApps };
  });

  ipcMain.handle('focusAudio:setEnabled', (_event, enabled: boolean) => {
    manager.setEnabled(enabled);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:setMode', (_event, mode: 'whitelist' | 'blacklist') => {
    manager.setMode(mode);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:setWhitelist', (_event, list: string[]) => {
    manager.setWhitelist(list);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:setBlacklist', (_event, list: string[]) => {
    manager.setBlacklist(list);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:getActiveApps', async () => {
    return manager.refreshActiveAudioApps();
  });
}
