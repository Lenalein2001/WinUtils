import { handleTrustedIpc } from './ipcSecurity';
import { BrowserWindow } from 'electron';
import type { ClipboardClearMode, ClipboardQuery, ClipboardSettings } from '../shared/clipboard';
import type { ClipboardManager } from './clipboardManager';

export function registerClipboardIpcHandlers(manager: ClipboardManager): void {
  handleTrustedIpc('clipboard:getState', async (_event, query?: ClipboardQuery) => manager.getState(query));
  handleTrustedIpc('clipboard:captureNow', async () => manager.captureNow());
  handleTrustedIpc('clipboard:setStorageBudget', async (_event, budget: number) => manager.setStorageBudget(budget));
  handleTrustedIpc('clipboard:enableEncryption', async () => manager.enableEncryption());
  handleTrustedIpc('clipboard:setExcludedApps', async (_event, apps: string[]) => manager.setExcludedApps(apps));
  handleTrustedIpc('clipboard:setMonitoring', async (_event, enabled: boolean) => manager.setMonitoring(enabled));
  handleTrustedIpc('clipboard:setCaptureImages', async (_event, enabled: boolean) => manager.setCaptureImages(enabled));
  handleTrustedIpc('clipboard:setImageOcr', async (_event, enabled: boolean) => manager.setImageOcr(enabled));
  handleTrustedIpc('clipboard:setRetention', async (_event, settings: Pick<ClipboardSettings, 'retentionDays' | 'maxEntries'>) => manager.setRetention(settings));
  handleTrustedIpc('clipboard:setPinned', async (_event, id: string, pinned: boolean) => manager.setPinned(id, pinned));
  handleTrustedIpc('clipboard:copy', async (_event, id: string) => manager.copyEntry(id));
  handleTrustedIpc('clipboard:delete', async (_event, id: string) => manager.deleteEntry(id));
  handleTrustedIpc('clipboard:clear', async (_event, mode: ClipboardClearMode) => manager.clear(mode));
  handleTrustedIpc('clipboard:rerunOcr', async (_event, id: string) => manager.rerunOcr(id));
  handleTrustedIpc('clipboard:openQuickAccess', async () => manager.openQuickAccess());
  handleTrustedIpc('clipboard:hideQuickAccess', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && new URL(event.sender.getURL()).hash === '#clipboard-popup') {
      window.hide();
    }
  });
}
