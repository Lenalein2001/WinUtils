import { dialog, ipcMain } from 'electron';
import { StartupManager } from './startupManager';

export function registerIpcHandlers(startupManager: StartupManager): void {
  ipcMain.handle('startup-apps:list', async () => startupManager.listEntries());
  ipcMain.handle('startup-apps:disable', async (_event, id: string) => startupManager.disableEntry(id));
  ipcMain.handle('startup-apps:enable', async (_event, id: string) => startupManager.enableEntry(id));
  ipcMain.handle('startup-apps:delete', async (_event, id: string) => startupManager.deleteEntry(id));
  ipcMain.handle(
    'startup-apps:add',
    async (_event, input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }) =>
      startupManager.addEntry(input),
  );
  ipcMain.handle(
    'startup-apps:update',
    async (_event, input: { id: string; executablePath: string; arguments?: string }) =>
      startupManager.updateEntry(input),
  );
  ipcMain.handle('startup-apps:pickExecutable', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Applications', extensions: ['exe', 'bat', 'cmd', 'com', 'ps1'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });
}
