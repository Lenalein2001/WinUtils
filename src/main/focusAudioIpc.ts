import { ipcMain } from 'electron';
import type { FocusAudioDuckRule } from '../shared/focusAudio';
import type { FocusAudioManager } from './focusAudioManager';

export function registerFocusAudioIpcHandlers(manager: FocusAudioManager): void {
  ipcMain.handle('focusAudio:getState', async () => {
    const config = manager.getConfig();
    return {
      ...config,
      activeAudioApps: manager.getCachedActiveAudioApps(),
      playingApps: manager.getCachedPlayingApps(),
      duckedApps: manager.getCachedDuckedApps(),
    };
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

  ipcMain.handle('focusAudio:setDuckingEnabled', (_event, enabled: boolean) => {
    manager.setDuckingEnabled(enabled);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:setDuckRules', (_event, rules: FocusAudioDuckRule[]) => {
    manager.setDuckRules(rules);
    return manager.getConfig();
  });

  ipcMain.handle('focusAudio:getActiveApps', async () => {
    return manager.refreshActiveAudioApps();
  });
}
