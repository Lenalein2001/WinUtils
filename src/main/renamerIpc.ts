import { handleTrustedIpc } from './ipcSecurity';
import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { RenameRule, RenamerLoadOptions, RenamerLoadPathsInput, RenamerPreviewInput } from '../shared/renamer';
import type { RenamerManager } from './renamerManager';

export function registerRenamerIpcHandlers(manager: RenamerManager): void {
  handleTrustedIpc('renamer:pickFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return manager.loadPaths({ paths: result.filePaths, recursive: false, includeFolders: false });
  });

  handleTrustedIpc('renamer:pickFolder', async (_event, options: RenamerLoadOptions) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    return manager.loadPaths({ paths: result.filePaths, ...options });
  });

  handleTrustedIpc('renamer:loadPaths', async (_event, input: RenamerLoadPathsInput) => manager.loadPaths(input));
  handleTrustedIpc('renamer:preview', async (_event, input: RenamerPreviewInput) => manager.preview(input));
  handleTrustedIpc('renamer:apply', async (_event, input: RenamerPreviewInput) => manager.apply(input));
  handleTrustedIpc('renamer:undo', async (_event, transactionId?: string) => manager.undo(transactionId));
  handleTrustedIpc('renamer:listTransactions', async () => manager.listTransactions());
  handleTrustedIpc('renamer:defaultRules', () => createDefaultRenameRules());
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