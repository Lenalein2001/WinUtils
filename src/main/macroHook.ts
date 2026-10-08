import { app, BrowserWindow } from 'electron';
import { normalizeHotkey } from '../shared/hotkeys';
import { nativeMacroWorker, type NativeInputInstruction } from './nativeMacroWorker';

export interface HotkeyCallbacks {
  down: () => void;
  up?: () => void;
  suppressWhenAppFocused?: boolean;
  nativeProgram?: NativeInputInstruction[];
}
export type HotkeyBackend = 'native-worker' | 'native-polling' | 'none';
export interface HotkeyDiagnostics { hotkey: string; backend: HotkeyBackend; hasReleaseHandler: boolean }
type HotkeyVkGroup = number[] | { char: string };
const KEYPAD_AND_SYSTEM_KEYS: Record<string, number> = {
  numadd: 0x6b, numpadadd: 0x6b, numsub: 0x6d, numsubtract: 0x6d, numpadsubtract: 0x6d,
  nummult: 0x6a, nummultiply: 0x6a, numpadmultiply: 0x6a,
  numdec: 0x6e, numdecimal: 0x6e, numpaddecimal: 0x6e,
  numdiv: 0x6f, numdivide: 0x6f, numpaddivide: 0x6f, numlock: 0x90, 'num-lock': 0x90,
  capslock: 0x14, 'caps-lock': 0x14, scrolllock: 0x91, 'scroll-lock': 0x91,
  printscreen: 0x2c, 'print-screen': 0x2c, pause: 0x13, oem5: 0xdc,
};
const callbacks = new Map<string, HotkeyCallbacks>();
const backends = new Map<string, HotkeyBackend>();
const pressed = new Map<string, HotkeyCallbacks>();
let retry: ReturnType<typeof setTimeout> | undefined;
let restarts = 0;
let hooked = false;
let fastEnabled = true;
let chain: Promise<void> = Promise.resolve();
let unsubscribe: (() => void) | null = null;
let revision = 0;

function enqueue(task: () => Promise<void>): Promise<void> {
  const next = chain.then(task);
  chain = next.catch(error => { backends.clear(); console.error('[Hotkeys] Native registration failed:', error); });
  return next;
}
function toCallbacks(callback: (() => void) | HotkeyCallbacks): HotkeyCallbacks {
  return typeof callback === 'function' ? { down: callback, suppressWhenAppFocused: true }
    : { ...callback, suppressWhenAppFocused: callback.suppressWhenAppFocused ?? true };
}
function sync(): Promise<void> {
  const version = ++revision;
  const entries = [...callbacks];
  const enabled = fastEnabled;
  return enqueue(async () => {
    if (!hooked || version !== revision) return;
    const bindings: Record<string, unknown>[] = [];
    const occupied = new Set(entries.map(([key]) => JSON.stringify(hotkeyVkGroupsForHotkey(key))));
    for (const [hotkey, callback] of entries) {
      const add = (chord: string, slot: string): void => {
        const groups = hotkeyVkGroupsForHotkey(chord);
        if (groups) bindings.push({ hotkey, slot, groups, trackRelease: Boolean(callback.up),
          suppressPid: callback.suppressWhenAppFocused ? process.pid : 0,
          ...(callback.nativeProgram ? { actions: callback.nativeProgram } : {}) });
      };
      add(hotkey, hotkey);
      const tokens = hotkey.split('+');
      const digit = tokens.findIndex(token => /^[0-9]$/.test(token));
      if (digit >= 0) {
        tokens[digit] = `num${tokens[digit]}`;
        const alias = tokens.join('+');
        if (!occupied.has(JSON.stringify(hotkeyVkGroupsForHotkey(alias)))) add(alias, `alias:${hotkey}`);
      }
    }
    const result = JSON.parse(await nativeMacroWorker.request({ op: 'hotkeys', fastEnabled: enabled, bindings })) as {
      bindings: Array<{ hotkey: string; registered: boolean }>;
    };
    if (version !== revision) return;
    backends.clear();
    for (const binding of result.bindings) {
      if (binding.registered || !backends.has(binding.hotkey)) backends.set(binding.hotkey, binding.registered ? 'native-worker' : 'native-polling');
    }
  });
}
export function registerHotkey(hotkey: string, callback: (() => void) | HotkeyCallbacks): void {
  callbacks.set(normalizeHotkey(hotkey), toCallbacks(callback)); void sync().catch(() => undefined);
}
export function replaceHotkeys(entries: Array<{ hotkey: string; callback: (() => void) | HotkeyCallbacks }>): void {
  const desired = new Map(entries.map(entry => [normalizeHotkey(entry.hotkey), toCallbacks(entry.callback)]));
  for (const [key, owner] of pressed) {
    if (desired.get(key)?.up !== owner.up) { pressed.delete(key); owner.up?.(); }
  }
  callbacks.clear();
  for (const entry of entries) { const key = normalizeHotkey(entry.hotkey); if (key) callbacks.set(key, toCallbacks(entry.callback)); }
  void sync().catch(() => undefined);
}
export function unregisterHotkey(hotkey: string): void { replaceHotkeys([...callbacks].filter(([key]) => key !== normalizeHotkey(hotkey)).map(([key, callback]) => ({ hotkey: key, callback }))); }
export function clearHotkeys(): void { replaceHotkeys([]); }
export async function suspendNativePlayback(): Promise<void> {
  return enqueue(async () => { if (nativeMacroWorker.isRunning()) await nativeMacroWorker.request({ op: 'cancel-fast' }); });
}
export function setNativePlaybackEnabled(enabled: boolean): void {
  fastEnabled = enabled;
  if (!enabled) void suspendNativePlayback().catch(() => undefined);
  void sync().catch(() => undefined);
}
export async function startHook(): Promise<void> {
  if (hooked) return;
  if (!app.isReady()) await app.whenReady();
  hooked = true;
  unsubscribe = nativeMacroWorker.onHotkey(event => {
    if (event.kind === 'WORKER_EXIT') {
      backends.clear(); for (const owner of pressed.values()) owner.up?.(); pressed.clear();
      if (hooked && !retry && restarts++ < 3) retry = setTimeout(() => { retry = undefined; if (hooked) void sync().catch(() => undefined); }, 1000);
      return;
    }
    const callback = callbacks.get(event.hotkey);
    if (!callback) return;
    if (event.kind === 'FAST_ERROR') { console.error('[Macros] Native playback failed:', event.value); return; }
    if (event.kind === 'HOTKEY_UP') { const owner = pressed.get(event.hotkey); pressed.delete(event.hotkey); owner?.up?.(); }
    if (event.kind === 'HOTKEY_DOWN') {
      const window = BrowserWindow.getFocusedWindow();
      if (!callback.suppressWhenAppFocused || !window || window.isDestroyed()) {
        if (callback.up) pressed.set(event.hotkey, callback);
        callback.down();
      }
    }
  });
  await sync();
}
export function stopHook(): void {
  hooked = false; unsubscribe?.(); unsubscribe = null; backends.clear();
  clearTimeout(retry); retry = undefined; restarts = 0;
  for (const owner of pressed.values()) owner.up?.(); pressed.clear();
  void enqueue(async () => { if (nativeMacroWorker.isRunning()) await nativeMacroWorker.request({ op: 'hotkeys', fastEnabled: false, bindings: [] }); }).catch(() => undefined);
}
export function getHotkeyDiagnostics(): {
  hotkeys: HotkeyDiagnostics[]; nativeWorkerRunning: boolean;
} {
  const running = nativeMacroWorker.isRunning();
  return { hotkeys: [...callbacks].map(([hotkey, callback]) => ({ hotkey, backend: running ? backends.get(hotkey) ?? 'none' : 'none', hasReleaseHandler: Boolean(callback.up) })),
    nativeWorkerRunning: running };
}
export async function waitForHotkeyRegistrations(): Promise<void> { await chain; }

function hotkeyVkGroupsForHotkey(hotkey: string): HotkeyVkGroup[] | null {
  const groups = normalizeHotkey(hotkey).split('+').filter(Boolean).map(token => {
    const letter = token.match(/^[a-z]$/)?.[0];
    if (letter) return [letter.toUpperCase().charCodeAt(0)];

    const digit = token.match(/^[0-9]$/)?.[0];
    if (digit) return [digit.charCodeAt(0)];

    const functionKey = token.match(/^f(\d{1,2})$/)?.[1];
    if (functionKey && Number(functionKey) >= 1 && Number(functionKey) <= 24) return [0x6f + Number(functionKey)];
    const numpad = /^(?:num|numpad)([0-9])$/.exec(token);
    if (numpad) return [0x60 + Number(numpad[1])];
    if (KEYPAD_AND_SYSTEM_KEYS[token]) return [KEYPAD_AND_SYSTEM_KEYS[token]];

    switch (token) {
      case 'ctrl':
      case 'control':
        return [0x11];
      case 'alt':
        return [0x12];
      case 'shift':
        return [0x10];
      case 'win':
      case 'meta':
      case 'super':
        return [0x5b, 0x5c];
      case 'enter':
      case 'return':
        return [0x0d];
      case 'space':
        return [0x20];
      case 'escape':
      case 'esc':
        return [0x1b];
      case 'tab':
        return [0x09];
      case 'backspace':
        return [0x08];
      case 'delete':
      case 'del':
        return [0x2e];
      case 'insert':
        return [0x2d];
      case 'left':
      case 'arrowleft':
        return [0x25];
      case 'right':
      case 'arrowright':
        return [0x27];
      case 'up':
      case 'arrowup':
        return [0x26];
      case 'down':
      case 'arrowdown':
        return [0x28];
      case 'home':
        return [0x24];
      case 'end':
        return [0x23];
      case 'pageup':
      case 'pgup':
        return [0x21];
      case 'pagedown':
      case 'pgdn':
        return [0x22];
      case 'semicolon':
      case ';':
        return [0xba];
      case 'equal':
      case '=':
        return [0xbb];
      case 'comma':
      case ',':
        return [0xbc];
      case 'minus':
      case '-':
        return [0xbd];
      case 'period':
      case '.':
        return [0xbe];
      case 'slash':
      case '/':
        return [0xbf];
      case 'backquote':
      case '`':
        return [0xc0];
      case 'bracketleft':
      case '[':
        return [0xdb];
      case 'backslash':
      case '\\':
        return [0xdc];
      case 'bracketright':
      case ']':
        return [0xdd];
      case 'quote':
      case "'":
        return [0xde];
      default:
        if (token.length === 1) return { char: token };
        return null;
    }
  });

  return groups.length > 0 && groups.every((group): group is HotkeyVkGroup => group !== null) ? groups : null;
}
