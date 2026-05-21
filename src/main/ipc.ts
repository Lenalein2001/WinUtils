import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { StartupEntry } from '../shared/startup';
import { AdminRequiredError, StartupManager } from './startupManager';

export function registerIpcHandlers(startupManager: StartupManager, prepareForAdminRelaunch: () => void): void {
  ipcMain.handle('startup-apps:list', async () => startupManager.listEntries());
  ipcMain.handle('startup-apps:disable', async (event, id: string) =>
    handleStartupMutation(event, () => startupManager.disableEntry(id), prepareForAdminRelaunch));
  ipcMain.handle('startup-apps:enable', async (event, id: string) =>
    handleStartupMutation(event, () => startupManager.enableEntry(id), prepareForAdminRelaunch));
  ipcMain.handle('startup-apps:delete', async (event, id: string) =>
    handleStartupMutation(event, () => startupManager.deleteEntry(id), prepareForAdminRelaunch));
  ipcMain.handle(
    'startup-apps:add',
    async (event, input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }) =>
      handleStartupMutation(event, () => startupManager.addEntry(input), prepareForAdminRelaunch),
  );
  ipcMain.handle(
    'startup-apps:update',
    async (event, input: { id: string; executablePath: string; arguments?: string }) =>
      handleStartupMutation(event, () => startupManager.updateEntry(input), prepareForAdminRelaunch),
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

async function handleStartupMutation(
  event: IpcMainInvokeEvent,
  action: () => Promise<StartupEntry[]>,
  prepareForAdminRelaunch: () => void,
): Promise<StartupEntry[]> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      await askForAdminRelaunch(event, error, prepareForAdminRelaunch);
    }

    throw error;
  }
}

async function askForAdminRelaunch(
  event: IpcMainInvokeEvent,
  error: AdminRequiredError,
  prepareForAdminRelaunch: () => void,
): Promise<void> {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Restart as Administrator', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Administrator permission required',
    message: 'Restart WinUtils as administrator?',
    detail: `${error.message}\n\nWinUtils needs elevated permission for this startup entry. After the restart, repeat the action from Startup Apps.`,
  };
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);

  if (result.response !== 0) return;

  startElevatedRelaunchHelper();
  prepareForAdminRelaunch();
  app.quit();
}

function startElevatedRelaunchHelper(): void {
  const command = '$processId = [int]$args[0]; $exePath = $args[1]; Wait-Process -Id $processId -ErrorAction SilentlyContinue; Start-Process -FilePath $exePath -Verb RunAs';
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-Command',
    command,
    String(process.pid),
    process.execPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
}
