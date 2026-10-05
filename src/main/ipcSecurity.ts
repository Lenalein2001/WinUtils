import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL, URL } from 'node:url';

export type AppWindowRole = 'main' | 'tray' | 'clipboard' | 'command-palette';
interface TrustedWindow { role: AppWindowRole; documentUrl: string }
const trustedWindows = new WeakMap<Electron.WebContents, TrustedWindow>();
let closing = false;
const activeRequests = new Map<Promise<unknown>, string>();
export function stopAcceptingIpc(): void { closing = true; }
export async function drainIpcRequests(): Promise<void> {
  // Installing an update invokes shutdown itself and cannot await its own IPC.
  await Promise.allSettled([...activeRequests].filter(([, channel]) => channel !== 'updates:install').map(([pending]) => pending));
}
const restrictedChannels: Record<Exclude<AppWindowRole, 'main'>, ReadonlySet<string>> = {
  tray: new Set(['tray:show-main', 'tray:quit']),
  clipboard: new Set(['clipboard:getState', 'clipboard:copy', 'clipboard:hideQuickAccess']),
  'command-palette': new Set(['actions:list', 'actions:execute', 'commandPalette:hide']),
};
const hashes: Record<AppWindowRole, string> = { main: '', tray: '#tray', clipboard: '#clipboard-popup', 'command-palette': '#command-palette' };

export function rendererDocumentUrl(rendererHtmlPath: string): string {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('The renderer development server must use a loopback HTTP/HTTPS URL.');
    }
    url.hash = '';
    return url.href;
  }
  return pathToFileURL(path.resolve(rendererHtmlPath)).href;
}

/** Register the actual WebContents, not just a URL which any new window could load. */
export function protectAppWindow(window: BrowserWindow, role: AppWindowRole, documentUrl: string): void {
  const contents = window.webContents;
  const expected = new URL(documentUrl);
  expected.hash = hashes[role];
  trustedWindows.set(contents, { role, documentUrl: expected.href });
  const denyNavigation = (event: Electron.Event): void => { event.preventDefault(); };
  contents.on('will-navigate', denyNavigation);
  contents.on('will-frame-navigate', denyNavigation);
  contents.on('will-redirect', denyNavigation);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  // WinUtils uses main-process notifications and OS helpers, not renderer grants.
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.once('destroyed', () => trustedWindows.delete(contents));
}

export function assertTrustedIpc(event: IpcMainInvokeEvent, channel: string): void {
  if (closing) throw new Error('WinUtils is shutting down.');
  const trusted = trustedWindows.get(event.sender);
  if (!trusted || event.sender.isDestroyed() || !event.senderFrame
    || event.senderFrame !== event.sender.mainFrame
    || event.senderFrame.url !== trusted.documentUrl || event.sender.getURL() !== trusted.documentUrl) {
    throw new Error('IPC request rejected: untrusted document or frame.');
  }
  if (trusted.role !== 'main' && !restrictedChannels[trusted.role].has(channel)) {
    throw new Error('IPC request rejected: this window cannot perform that operation.');
  }
}

export function handleTrustedIpc(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event, channel);
    const result = handler(event, ...args);
    if (result && typeof result.then === 'function') {
      const pending = Promise.resolve(result);
      activeRequests.set(pending, channel);
      void pending.then(() => activeRequests.delete(pending), () => activeRequests.delete(pending));
    }
    return result;
  });
}
