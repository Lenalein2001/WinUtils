import { handleTrustedIpc } from './ipcSecurity';

import type { SaveWindowLayoutInput, WindowCommand } from '../shared/windowManager';
import type { WindowManager } from './windowManager';

export function registerWindowIpcHandlers(manager: WindowManager): void {
  handleTrustedIpc('windows:getState', () => manager.getState());
  handleTrustedIpc('windows:restoreAll', async () => { await manager.restoreAll(); return manager.getState(); });
  handleTrustedIpc('windows:execute', (_event, command: WindowCommand) => manager.execute(command));
  handleTrustedIpc('windows:saveLayout', (_event, input: SaveWindowLayoutInput) => manager.saveLayout(input));
  handleTrustedIpc('windows:deleteLayout', (_event, layoutId: string) => manager.deleteLayout(layoutId));
  handleTrustedIpc('windows:applyLayout', (_event, layoutId: string) => manager.applyLayout(layoutId));
}
