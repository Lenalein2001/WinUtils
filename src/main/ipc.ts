import { spawn } from 'node:child_process';
import { app, dialog, ipcMain } from 'electron';
import type { StartupEntry } from '../shared/startup';
import { AdminRequiredError, StartupManager } from './startupManager';

export function registerIpcHandlers(startupManager: StartupManager, prepareForAdminRelaunch: () => void): void {
  ipcMain.handle('startup-apps:list', async () => startupManager.listEntries());
  ipcMain.handle('startup-apps:disable', async (event, id: string) =>
    handleStartupMutation(() => startupManager.disableEntry(id)));
  ipcMain.handle('startup-apps:enable', async (event, id: string) =>
    handleStartupMutation(() => startupManager.enableEntry(id)));
  ipcMain.handle('startup-apps:delete', async (event, id: string) =>
    handleStartupMutation(() => startupManager.deleteEntry(id)));
  ipcMain.handle(
    'startup-apps:add',
    async (event, input: { name: string; executablePath: string; arguments?: string; scope: 'current-user' | 'all-users' }) =>
      handleStartupMutation(() => startupManager.addEntry(input)),
  );
  ipcMain.handle(
    'startup-apps:update',
    async (event, input: { id: string; executablePath: string; arguments?: string }) =>
      handleStartupMutation(() => startupManager.updateEntry(input)),
  );
  ipcMain.handle('startup-apps:restartAsAdmin', () => restartAsAdmin(prepareForAdminRelaunch));
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

async function restartAsAdmin(prepareForAdminRelaunch: () => void): Promise<void> {
  app.releaseSingleInstanceLock();

  try {
    await startElevatedRelaunchHelper();
  } catch (error) {
    app.requestSingleInstanceLock();
    throw error;
  }

  prepareForAdminRelaunch();
  app.quit();
}

function startElevatedRelaunchHelper(): Promise<void> {
  const script = buildElevatedRelaunchScript();
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedScript,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let errorOutput = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString('utf8');
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(errorOutput.trim() || 'Windows did not start the administrator relaunch.'));
    });
  });
}

function buildElevatedRelaunchScript(): string {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const argumentList = args.length
    ? ` -ArgumentList @(${args.map(quotePowerShellString).join(', ')})`
    : '';
  const workingDirectory = ` -WorkingDirectory ${quotePowerShellString(process.cwd())}`;

  return `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quotePowerShellString(process.execPath)}${workingDirectory}${argumentList} -Verb RunAs`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
