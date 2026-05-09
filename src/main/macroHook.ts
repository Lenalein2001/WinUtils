/**
 * Global hotkey registration backed by Electron's globalShortcut.
 * This is more reliable than low-level scan-code hooks for synthetic vendor keys
 * (for example Razer keys mapped to F13-F24).
 */

import { app, globalShortcut } from 'electron';

let hooked = false;

const callbacks = new Map<string, () => void>();

function normalizeHotkey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

function toElectronAccelerator(hotkey: string): string | null {
  const normalized = normalizeHotkey(hotkey);
  if (!normalized) return null;

  const tokens = normalized.split('+').filter(Boolean);
  if (tokens.length === 0) return null;

  const modifiers: string[] = [];
  let key: string | null = null;

  for (const token of tokens) {
    if (token === 'ctrl' || token === 'control') {
      modifiers.push('Control');
      continue;
    }
    if (token === 'alt') {
      modifiers.push('Alt');
      continue;
    }
    if (token === 'shift') {
      modifiers.push('Shift');
      continue;
    }
    if (token === 'win' || token === 'meta' || token === 'super') {
      modifiers.push('Super');
      continue;
    }

    if (/^f\d{1,2}$/.test(token)) {
      key = token.toUpperCase();
      continue;
    }

    if (token.length === 1) {
      key = token.toUpperCase();
      continue;
    }

    if (token === 'space') {
      key = 'Space';
      continue;
    }
    if (token === 'escape' || token === 'esc') {
      key = 'Esc';
      continue;
    }
    if (token === 'enter' || token === 'return') {
      key = 'Enter';
      continue;
    }
    if (token === 'tab') {
      key = 'Tab';
      continue;
    }
    if (token === 'backspace') {
      key = 'Backspace';
      continue;
    }
    if (token === 'delete' || token === 'del') {
      key = 'Delete';
      continue;
    }
    if (token === 'insert' || token === 'ins') {
      key = 'Insert';
      continue;
    }
    if (token === 'left') {
      key = 'Left';
      continue;
    }
    if (token === 'right') {
      key = 'Right';
      continue;
    }
    if (token === 'up') {
      key = 'Up';
      continue;
    }
    if (token === 'down') {
      key = 'Down';
      continue;
    }
    if (token === 'home') {
      key = 'Home';
      continue;
    }
    if (token === 'end') {
      key = 'End';
      continue;
    }
    if (token === 'pageup' || token === 'pgup') {
      key = 'PageUp';
      continue;
    }
    if (token === 'pagedown' || token === 'pgdn') {
      key = 'PageDown';
      continue;
    }
  }

  if (!key) return null;
  return [...modifiers, key].join('+');
}

function registerAllHotkeys(): void {
  globalShortcut.unregisterAll();

  for (const [hotkey, cb] of callbacks) {
    const accelerator = toElectronAccelerator(hotkey);
    if (!accelerator) continue;
    globalShortcut.register(accelerator, () => {
      try { cb(); } catch { /* ignore callback crash */ }
    });
  }
}

export function registerHotkey(hotkey: string, callback: () => void): void {
  callbacks.set(normalizeHotkey(hotkey), callback);
  if (hooked) registerAllHotkeys();
}

export function unregisterHotkey(hotkey: string): void {
  callbacks.delete(normalizeHotkey(hotkey));
  if (hooked) registerAllHotkeys();
}

export function clearHotkeys(): void {
  callbacks.clear();
  if (hooked) globalShortcut.unregisterAll();
}

export async function startHook(): Promise<void> {
  if (hooked) return;

  if (!app.isReady()) {
    // Guard against early calls from future refactors.
    await app.whenReady();
  }

  try {
    registerAllHotkeys();
  } catch {
    console.warn('[MacroHook] Failed to register global shortcuts.');
    return;
  }
  hooked = true;
}

export function stopHook(): void {
  if (!hooked) return;
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  hooked = false;
}
