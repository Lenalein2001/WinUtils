import { ipcMain } from 'electron';
import type { UpdateManager } from './updateManager';

export function registerUpdateIpcHandlers(manager: UpdateManager): void {
  ipcMain.handle('updates:getState', () => manager.getState());
  ipcMain.handle('updates:check', () => manager.checkForUpdates());
  ipcMain.handle('updates:download', () => manager.downloadUpdate());
  ipcMain.handle('updates:install', () => manager.installUpdate());
  ipcMain.handle('updates:openReleasePage', () => manager.openReleasePage());
  ipcMain.handle('updates:getLatestRelease', () => manager.getLatestRelease());
  ipcMain.handle('updates:getReleaseHistory', () => manager.getReleaseHistory());
}
