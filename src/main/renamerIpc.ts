import { randomUUID } from 'node:crypto';
import { dialog, ipcMain } from 'electron';
import type { RenameRule, RenamerLoadOptions, RenamerLoadPathsInput, RenamerPreviewInput } from '../shared/renamer';
import type { RenamerManager } from './renamerManager';

export function registerRenamerIpcHandlers(manager: RenamerManager): void {
  ipcMain.handle('renamer:pickFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return manager.loadPaths({ paths: result.filePaths, recursive: false, includeFolders: false });
  });

  ipcMain.handle('renamer:pickFolder', async (_event, options: RenamerLoadOptions) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return manager.loadPaths({ paths: result.filePaths, ...options });
  });

  ipcMain.handle('renamer:loadPaths', async (_event, input: RenamerLoadPathsInput) => manager.loadPaths(input));
  ipcMain.handle('renamer:preview', async (_event, input: RenamerPreviewInput) => manager.preview(input));
  ipcMain.handle('renamer:apply', async (_event, input: RenamerPreviewInput) => manager.apply(input));
  ipcMain.handle('renamer:undo', async (_event, transactionId?: string) => manager.undo(transactionId));
  ipcMain.handle('renamer:listTransactions', async () => manager.listTransactions());
  ipcMain.handle('renamer:defaultRules', () => createDefaultRenameRules());
}

function createDefaultRenameRules(): RenameRule[] {
  return [
    {
      id: randomUUID(),
      type: 'find-replace',
      enabled: true,
      find: '',
      replace: '',
      useRegex: false,
      caseSensitive: false,
    },
  ];
}