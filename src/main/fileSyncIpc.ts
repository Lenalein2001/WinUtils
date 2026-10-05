import { handleTrustedIpc } from './ipcSecurity';
import { dialog } from 'electron';
import type { FileSyncJobInput } from '../shared/fileSync';
import type { FileSyncManager } from './fileSyncManager';

export function registerFileSyncIpcHandlers(manager: FileSyncManager): void {
  handleTrustedIpc('fileSync:getState', async () => manager.getState());
  handleTrustedIpc('fileSync:listRecovery', async () => manager.listRecovery());
  handleTrustedIpc('fileSync:restoreRecovery', async (_event, id: string) => manager.restoreRecovery(id));
  handleTrustedIpc('fileSync:purgeRecovery', async (_event, id: string) => manager.purgeRecovery(id));
  handleTrustedIpc('fileSync:createJob', async (_event, input?: FileSyncJobInput) => manager.createJob(input));
  handleTrustedIpc('fileSync:updateJob', async (_event, id: string, input: FileSyncJobInput) => manager.updateJob(id, input));
  handleTrustedIpc('fileSync:deleteJob', async (_event, id: string) => manager.deleteJob(id));
  handleTrustedIpc('fileSync:analyze', async (_event, jobId: string) => manager.analyze(jobId));
  handleTrustedIpc('fileSync:apply', async (_event, jobId: string) => manager.apply(jobId));
  handleTrustedIpc('fileSync:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
