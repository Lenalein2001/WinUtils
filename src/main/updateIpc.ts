import { handleTrustedIpc } from './ipcSecurity';

import type { UpdateManager } from './updateManager';

export function registerUpdateIpcHandlers(manager: UpdateManager): void {
  handleTrustedIpc('updates:getState', () => manager.getState());
  handleTrustedIpc('updates:check', () => manager.checkForUpdates());
  handleTrustedIpc('updates:download', () => manager.downloadUpdate());
  handleTrustedIpc('updates:cancelDownload', () => manager.cancelDownload());
  handleTrustedIpc('updates:install', () => manager.installUpdate());
  handleTrustedIpc('updates:openReleasePage', () => manager.openReleasePage());
  handleTrustedIpc('updates:getLatestRelease', () => manager.getLatestRelease());
  handleTrustedIpc('updates:getReleaseHistory', () => manager.getReleaseHistory());
}
