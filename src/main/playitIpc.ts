import { ipcMain, shell } from 'electron';
import type { PlayitTunnelInput, PlayitTunnelUpdateInput } from '../shared/playit';
import type { PlayitManager } from './playitManager';

export function registerPlayitIpcHandlers(manager: PlayitManager): void {
  ipcMain.handle('playit:getState', async () => manager.getState());
  ipcMain.handle('playit:installWithWinget', async () => manager.installWithWinget());
  ipcMain.handle('playit:installFromDownload', async () => manager.installFromDownload());
  ipcMain.handle('playit:startAgentClaim', async () => {
    const claim = await manager.startAgentClaim();
    await shell.openExternal(claim.claimUrl);
    return claim;
  });
  ipcMain.handle('playit:completeAgentClaim', async (_event, claimCode: string) => manager.completeAgentClaim(claimCode));
  ipcMain.handle('playit:createTunnel', async (_event, input: PlayitTunnelInput) => manager.createTunnel(input));
  ipcMain.handle('playit:updateTunnel', async (_event, input: PlayitTunnelUpdateInput) => manager.updateTunnel(input));
  ipcMain.handle('playit:deleteTunnel', async (_event, id: string) => manager.deleteTunnel(id));
  ipcMain.handle('playit:startAgent', async () => manager.startAgent());
  ipcMain.handle('playit:openDownloadPage', async () => {
    await shell.openExternal('https://playit.gg/download/windows');
  });
  ipcMain.handle('playit:openAccountPage', async () => {
    await shell.openExternal('https://playit.gg/account/agents');
  });
  ipcMain.handle('playit:openTunnelSetupPage', async () => {
    await shell.openExternal(await manager.getTunnelSetupUrl());
  });
}