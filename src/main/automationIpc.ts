import { handleTrustedIpc } from './ipcSecurity';
import { BrowserWindow } from 'electron';
import type { AutomationActionRequest } from '../shared/actions';
import type { HotkeyActionBindingInput, HotkeyUpdateInput } from '../shared/hotkeys';
import type { ActionEngine } from './actionEngine';
import type { HotkeyManager } from './hotkeyManager';

export function registerAutomationIpcHandlers(actions: ActionEngine, hotkeys: HotkeyManager): void {
  handleTrustedIpc('actions:list', () => actions.getCatalog());
  handleTrustedIpc('actions:execute', (_event, request: AutomationActionRequest) => actions.execute(request));
  handleTrustedIpc('hotkeys:getState', () => hotkeys.getState());
  handleTrustedIpc('hotkeys:update', (_event, input: HotkeyUpdateInput) => hotkeys.updateBinding(input));
  handleTrustedIpc('hotkeys:createActionBinding', (_event, input: HotkeyActionBindingInput) =>
    hotkeys.createActionBinding(input));
  handleTrustedIpc('hotkeys:deleteActionBinding', (_event, bindingId: string) =>
    hotkeys.deleteActionBinding(bindingId));
  handleTrustedIpc('commandPalette:hide', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && new URL(event.sender.getURL()).hash === '#command-palette') {
      window.hide();
    }
  });
}

export function registerAutomationSafetyIpc(actions: ActionEngine, stop: () => Promise<void>, resume: () => Promise<void>): void {
  handleTrustedIpc('actions:activity', () => actions.getActivity());
  handleTrustedIpc('actions:clearHistory', () => actions.clearHistory());
  handleTrustedIpc('actions:stop', async () => { actions.cancelAll(); await stop(); return actions.getActivity(); });
  handleTrustedIpc('actions:resume', async () => { await resume(); actions.resume(); return actions.getActivity(); });
}
