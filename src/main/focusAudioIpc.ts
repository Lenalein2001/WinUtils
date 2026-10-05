import { handleTrustedIpc } from './ipcSecurity';

import type { FocusAudioDuckRule } from '../shared/focusAudio';
import type { FocusAudioManager } from './focusAudioManager';

export function registerFocusAudioIpcHandlers(manager: FocusAudioManager): void {
  handleTrustedIpc('focusAudio:getState', async () => {
    const config = manager.getConfig();
    return {
      ...config,
      lastError: manager.getLastError(),
      activeAudioApps: manager.getCachedActiveAudioApps(),
      playingApps: manager.getCachedPlayingApps(),
      duckedApps: manager.getCachedDuckedApps(),
    };
  });

  handleTrustedIpc('focusAudio:setEnabled', async (_event, enabled: boolean) => {
    await manager.setEnabled(enabled);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:setMode', async (_event, mode: 'whitelist' | 'blacklist') => {
    await manager.setMode(mode);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:setWhitelist', async (_event, list: string[]) => {
    await manager.setWhitelist(list);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:setBlacklist', async (_event, list: string[]) => {
    await manager.setBlacklist(list);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:setDuckingEnabled', async (_event, enabled: boolean) => {
    await manager.setDuckingEnabled(enabled);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:setDuckRules', async (_event, rules: FocusAudioDuckRule[]) => {
    await manager.setDuckRules(rules);
    return manager.getConfig();
  });

  handleTrustedIpc('focusAudio:getActiveApps', async () => {
    return manager.refreshActiveAudioApps();
  });
}
