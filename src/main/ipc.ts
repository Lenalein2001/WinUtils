import { handleTrustedIpc } from './ipcSecurity';
import { dialog } from 'electron';
import type { StartupEntry, StartupMutation } from '../shared/startup';
import { AdminRequiredError, StartupManager } from './startupManager';

export function registerIpcHandlers(startupManager: StartupManager): void {
  handleTrustedIpc('startup-apps:list', async () => startupManager.listEntries());
  handleTrustedIpc('startup-apps:disable', async (event, id: string) =>
    handleStartupMutation(() => startupManager.disableEntry(id)));
  handleTrustedIpc('startup-apps:enable', async (event, id: string) =>
    handleStartupMutation(() => startupManager.enableEntry(id)));
  handleTrustedIpc('startup-apps:delete', async (event, id: string) =>
    handleStartupMutation(() => startupManager.deleteEntry(id)));
  handleTrustedIpc(
    'startup-apps:add',
    async (event, input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }) =>
      handleStartupMutation(() => startupManager.addEntry(input)),
  );
  handleTrustedIpc(
    'startup-apps:update',
    async (event, input: { id: string; executablePath: string; arguments?: string }) =>
      handleStartupMutation(() => startupManager.updateEntry(input)),
  );
  handleTrustedIpc('startup-apps:retryWithPermission', (_event, request: StartupMutation) => startupManager.retryWithPermission(request));
  handleTrustedIpc('startup-apps:pickExecutable', async () => {
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

async function handleStartupMutation(
  action: () => Promise<StartupEntry[]>,
): Promise<StartupEntry[]> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      throw new Error(error.message);
    }

    throw error;
  }
}
