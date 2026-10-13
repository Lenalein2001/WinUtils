import type { BrowserWindow } from 'electron';

export function guardEditorClose(window: BrowserWindow, options: {
  isQuitting: () => boolean;
  closeToTray: () => boolean;
  hide: () => void;
  flush: () => Promise<void>;
  failed: (error: unknown) => void;
}): void {
  let permitClose = false, flushing = false;
  window.on('close', event => {
    if (options.isQuitting()) return;
    if (permitClose) return;
    if (options.closeToTray()) { event.preventDefault(); options.hide(); return; }
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    void options.flush().then(() => { permitClose = true; if (!window.isDestroyed()) window.close(); }).catch(error => {
      flushing = false;
      if (!window.isDestroyed()) options.failed(error);
    });
  });
}
