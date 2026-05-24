/**
 * Global hotkey registration backed by Electron's globalShortcut.
 * This is more reliable than low-level scan-code hooks for synthetic vendor keys
 * (for example Razer keys mapped to F13-F24).
 */

import { app, globalShortcut } from 'electron';

let hooked = false;

const callbacks = new Map<string, () => void>();
const registeredAccelerators = new Set<string>();

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

    const numpadKey = toNumpadAcceleratorKey(token);
    if (numpadKey) {
      key = numpadKey;
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
    if (token === 'numlock' || token === 'num-lock') {
      key = 'Numlock';
      continue;
    }
  }

  if (!key) return null;
  return [...modifiers, key].join('+');
}

function toNumpadAcceleratorKey(token: string): string | null {
  const digit = token.match(/^(?:num|numpad)([0-9])$/)?.[1];
  if (digit) return `num${digit}`;

  switch (token) {
    case 'numdec':
    case 'numdecimal':
    case 'numpaddecimal':
      return 'numdec';
    case 'numadd':
    case 'numpadadd':
      return 'numadd';
    case 'numsub':
    case 'numsubtract':
    case 'numpadsubtract':
      return 'numsub';
    case 'nummult':
    case 'nummultiply':
    case 'numpadmultiply':
      return 'nummult';
    case 'numdiv':
    case 'numdivide':
    case 'numpaddivide':
      return 'numdiv';
    default:
      return null;
  }
}

function registerAllHotkeys(): void {
  unregisterRegisteredHotkeys();

  const hotkeys = new Set(callbacks.keys());
  const attemptedAccelerators = new Set<string>();

  for (const [hotkey, cb] of callbacks) {
    for (const accelerator of toElectronAccelerators(hotkey, hotkeys)) {
      const registrationKey = accelerator.toLowerCase();
      if (attemptedAccelerators.has(registrationKey)) continue;
      attemptedAccelerators.add(registrationKey);

      const registered = globalShortcut.register(accelerator, () => {
        try { cb(); } catch { /* ignore callback crash */ }
      });
      if (registered) registeredAccelerators.add(accelerator);
    }
  }
}

function unregisterRegisteredHotkeys(): void {
  for (const accelerator of registeredAccelerators) {
    try { globalShortcut.unregister(accelerator); } catch { /* ignore stale shortcut */ }
  }
  registeredAccelerators.clear();
}

function toElectronAccelerators(hotkey: string, hotkeys: Set<string>): string[] {
  const accelerators = new Set<string>();
  const primary = toElectronAccelerator(hotkey);
  if (primary) accelerators.add(primary);

  const legacyNumpadAlias = toLegacyNumpadAlias(hotkey, hotkeys);
  if (legacyNumpadAlias) {
    const alias = toElectronAccelerator(legacyNumpadAlias);
    if (alias) accelerators.add(alias);
  }

  return [...accelerators];
}

function toLegacyNumpadAlias(hotkey: string, hotkeys: Set<string>): string | null {
  const tokens = normalizeHotkey(hotkey).split('+').filter(Boolean);
  const digitIndex = tokens.findIndex(token => /^[0-9]$/.test(token));
  if (digitIndex < 0) return null;

  const nonModifierTokens = tokens.filter(token => !isModifierToken(token));
  if (nonModifierTokens.length !== 1) return null;

  const aliasTokens = [...tokens];
  aliasTokens[digitIndex] = `num${tokens[digitIndex]}`;
  const alias = aliasTokens.join('+');
  const aliasAccelerator = toElectronAccelerator(alias)?.toLowerCase();
  if (!aliasAccelerator) return null;

  for (const existingHotkey of hotkeys) {
    if (existingHotkey === normalizeHotkey(hotkey)) continue;
    if (toElectronAccelerator(existingHotkey)?.toLowerCase() === aliasAccelerator) return null;
  }

  return alias;
}

function isModifierToken(token: string): boolean {
  return token === 'ctrl' || token === 'control' || token === 'alt' || token === 'shift' || token === 'win' || token === 'meta' || token === 'super';
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
  if (hooked) unregisterRegisteredHotkeys();
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
  unregisterRegisteredHotkeys();
  hooked = false;
}
