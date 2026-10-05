import { handleTrustedIpc } from './ipcSecurity';

import type { ExplorerContextMenuUpdate } from '../shared/contextMenu';
import type { ContextMenuManager } from './contextMenuManager';

export function registerContextMenuIpc(manager: ContextMenuManager): void {
  handleTrustedIpc('contextMenu:getState', () => manager.getState());
  handleTrustedIpc('contextMenu:update', (_event, input: ExplorerContextMenuUpdate) => manager.update(input));
  handleTrustedIpc('contextMenu:uninstall', () => manager.uninstall());
}
