import { ipcMain } from 'electron';
import type { AlwaysActiveMode, AlwaysActiveRuleUpdate } from '../shared/alwaysActive';
import type { AlwaysActiveManager } from './alwaysActiveManager';

export function registerAlwaysActiveIpcHandlers(manager: AlwaysActiveManager): void {
  ipcMain.handle('alwaysActive:getState', async () => manager.getState());
  ipcMain.handle('alwaysActive:refreshWindows', async () => manager.refreshWindows());
  ipcMain.handle('alwaysActive:setEnabled', async (_event, enabled: boolean) => manager.setEnabled(enabled));
  ipcMain.handle('alwaysActive:addRuleFromWindow', async (_event, windowId: string, mode?: AlwaysActiveMode) => manager.addRuleFromWindow(windowId, mode));
  ipcMain.handle('alwaysActive:updateRule', async (_event, patch: AlwaysActiveRuleUpdate) => manager.updateRule(patch));
  ipcMain.handle('alwaysActive:deleteRule', async (_event, id: string) => manager.deleteRule(id));
  ipcMain.handle('alwaysActive:pause', async (_event, seconds: number) => manager.pause(seconds));
}
