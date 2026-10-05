import { clipboard } from 'electron';

/** Honor the producer's Windows clipboard-history exclusion markers. */
export function isClipboardExcluded(): boolean {
  if (clipboard.has('ExcludeClipboardContentFromMonitorProcessing')) return true;
  if (clipboard.has('CanIncludeInClipboardHistory')) {
    const value = clipboard.readBuffer('CanIncludeInClipboardHistory');
    return value.length < 4 || value.readUInt32LE(0) === 0;
  }
  return false;
}
