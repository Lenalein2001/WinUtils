import { ipcMain } from 'electron';
import type { ClipboardClearMode, ClipboardQuery } from '../shared/clipboard';
import type { ClipboardManager } from './clipboardManager';

export function registerClipboardIpcHandlers(manager: ClipboardManager): void {
  ipcMain.handle('clipboard:getState', async (_event, query?: ClipboardQuery) => manager.getState(query));
  ipcMain.handle('clipboard:captureNow', async () => manager.captureNow());
  ipcMain.handle('clipboard:setMonitoring', async (_event, enabled: boolean) => manager.setMonitoring(enabled));
  ipcMain.handle('clipboard:setCaptureImages', async (_event, enabled: boolean) => manager.setCaptureImages(enabled));
  ipcMain.handle('clipboard:setImageOcr', async (_event, enabled: boolean) => manager.setImageOcr(enabled));
  ipcMain.handle('clipboard:setPinned', async (_event, id: string, pinned: boolean) => manager.setPinned(id, pinned));
  ipcMain.handle('clipboard:copy', async (_event, id: string) => manager.copyEntry(id));
  ipcMain.handle('clipboard:delete', async (_event, id: string) => manager.deleteEntry(id));
  ipcMain.handle('clipboard:clear', async (_event, mode: ClipboardClearMode) => manager.clear(mode));
  ipcMain.handle('clipboard:rerunOcr', async (_event, id: string) => manager.rerunOcr(id));
  ipcMain.handle('clipboard:openQuickAccess', async () => manager.openQuickAccess());
}