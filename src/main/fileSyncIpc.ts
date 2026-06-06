import { dialog, ipcMain } from 'electron';
import type { FileSyncJobInput } from '../shared/fileSync';
import type { FileSyncManager } from './fileSyncManager';

export function registerFileSyncIpcHandlers(manager: FileSyncManager): void {
  ipcMain.handle('fileSync:getState', async () => manager.getState());
  ipcMain.handle('fileSync:createJob', async (_event, input?: FileSyncJobInput) => manager.createJob(input));
  ipcMain.handle('fileSync:updateJob', async (_event, id: string, input: FileSyncJobInput) => manager.updateJob(id, input));
  ipcMain.handle('fileSync:deleteJob', async (_event, id: string) => manager.deleteJob(id));
  ipcMain.handle('fileSync:analyze', async (_event, jobId: string) => manager.analyze(jobId));
  ipcMain.handle('fileSync:apply', async (_event, jobId: string) => manager.apply(jobId));
  ipcMain.handle('fileSync:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
