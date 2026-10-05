import { handleTrustedIpc } from './ipcSecurity';

import type { AlwaysActiveMode, AlwaysActiveRuleUpdate } from '../shared/alwaysActive';
import type { AlwaysActiveManager } from './alwaysActiveManager';

export function registerAlwaysActiveIpcHandlers(manager: AlwaysActiveManager): void {
  handleTrustedIpc('alwaysActive:getState', async () => manager.getState());
  handleTrustedIpc('alwaysActive:refreshWindows', async () => manager.refreshWindows());
  handleTrustedIpc('alwaysActive:setEnabled', async (_event, enabled: boolean) => manager.setEnabled(enabled));
  handleTrustedIpc('alwaysActive:addRuleFromWindow', async (_event, windowId: string, mode?: AlwaysActiveMode) => manager.addRuleFromWindow(windowId, mode));
  handleTrustedIpc('alwaysActive:updateRule', async (_event, patch: AlwaysActiveRuleUpdate) => manager.updateRule(patch));
  handleTrustedIpc('alwaysActive:deleteRule', async (_event, id: string) => manager.deleteRule(id));
  handleTrustedIpc('alwaysActive:pause', async (_event, seconds: number) => manager.pause(seconds));
}
