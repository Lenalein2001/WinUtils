import { app, dialog } from 'electron';
import { handleTrustedIpc } from './ipcSecurity';
import { writeJsonAtomically } from './atomicFile';

/** An allowlisted summary: never read clipboard, commands, paths, window titles or logs. */
export function registerDiagnosticsIpc(): void {
  handleTrustedIpc('diagnostics:export', async (): Promise<boolean> => {
    const selected = await dialog.showSaveDialog({ defaultPath: 'WinUtils-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return false;
    const memory = process.memoryUsage();
    await writeJsonAtomically(selected.filePath, {
      product: 'WinUtils', schemaVersion: 1, version: app.getVersion(), packaged: app.isPackaged,
      platform: process.platform, architecture: process.arch,
      runtime: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
      uptimeSeconds: Math.floor(process.uptime()),
      memoryBytes: { resident: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
    });
    return true;
  });
}
