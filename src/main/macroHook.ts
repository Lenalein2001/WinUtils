/**
 * Global hotkey registration backed by Electron's globalShortcut for press events,
 * with uiohook-napi used for release tracking when a macro needs hold behavior.
 */

import { app, globalShortcut } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import type { UiohookKeyboardEvent } from 'uiohook-napi';

type UiohookModule = typeof import('uiohook-napi');

export interface HotkeyCallbacks {
  down: () => void;
  up?: () => void;
}

interface UiohookCombo {
  hotkey: string;
  keycodes: number[];
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  modifierKeycodes: number[];
  triggerModifier: 'ctrl' | 'alt' | 'shift' | 'meta' | null;
}

type HotkeyVkGroup = number[] | { char: string };

const nodeRequire = createRequire(import.meta.url);

let hooked = false;
let uiohookModule: UiohookModule | null | undefined;
let uiohookRunning = false;
let modifierHotkeyWorker: ChildProcessWithoutNullStreams | null = null;
let modifierHotkeyWorkerKey = '';
let modifierHotkeyWorkerBuffer = '';

const callbacks = new Map<string, HotkeyCallbacks>();
const registeredAccelerators = new Set<string>();
const electronRegisteredHotkeys = new Set<string>();
const uiohookCombos = new Map<string, UiohookCombo>();
const pressedHotkeys = new Set<string>();
const pendingStandaloneModifierHotkeys = new Set<string>();

function normalizeHotkey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

function toCallbacks(callback: (() => void) | HotkeyCallbacks): HotkeyCallbacks {
  return typeof callback === 'function' ? { down: callback } : callback;
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

    const physicalKey = toPhysicalAcceleratorKey(token);
    if (physicalKey) {
      key = physicalKey;
      continue;
    }

    if (/^[a-z0-9]$/.test(token)) {
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
    if (token === 'left' || token === 'arrowleft') {
      key = 'Left';
      continue;
    }
    if (token === 'right' || token === 'arrowright') {
      key = 'Right';
      continue;
    }
    if (token === 'up' || token === 'arrowup') {
      key = 'Up';
      continue;
    }
    if (token === 'down' || token === 'arrowdown') {
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

function toPhysicalAcceleratorKey(token: string): string | null {
  switch (token) {
    case 'semicolon': return ';';
    case 'equal': return '=';
    case 'comma': return ',';
    case 'minus': return '-';
    case 'period': return '.';
    case 'slash': return '/';
    case 'backquote': return '`';
    case 'bracketleft': return '[';
    case 'backslash': return '\\';
    case 'bracketright': return ']';
    case 'quote': return "'";
    default: return null;
  }
}

function registerAllHotkeys(): void {
  unregisterRegisteredHotkeys();

  const hotkeys = new Set(callbacks.keys());
  const attemptedAccelerators = new Set<string>();

  for (const hotkey of callbacks.keys()) {
    for (const accelerator of toElectronAccelerators(hotkey, hotkeys)) {
      const registrationKey = accelerator.toLowerCase();
      if (attemptedAccelerators.has(registrationKey)) continue;
      attemptedAccelerators.add(registrationKey);

      let registered = false;
      try {
        registered = globalShortcut.register(accelerator, () => {
          fireHotkeyDown(hotkey, true);
        });
      } catch {
        continue;
      }

      if (registered) {
        registeredAccelerators.add(accelerator);
        electronRegisteredHotkeys.add(hotkey);
      }
    }
  }

  syncUiohook();
  syncModifierHotkeyWorker();
}

function unregisterRegisteredHotkeys(): void {
  for (const accelerator of registeredAccelerators) {
    try { globalShortcut.unregister(accelerator); } catch { /* ignore stale shortcut */ }
  }
  registeredAccelerators.clear();
  electronRegisteredHotkeys.clear();
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

function getUiohookModule(): UiohookModule | null {
  if (uiohookModule !== undefined) return uiohookModule;

  try {
    uiohookModule = nodeRequire('uiohook-napi') as UiohookModule;
  } catch {
    uiohookModule = null;
  }

  return uiohookModule;
}

function syncUiohook(): void {
  uiohookCombos.clear();
  stopUiohook();
}

function shouldUseNativeHook(hotkey: string, callback: HotkeyCallbacks): boolean {
  if (isModifierOnlyHotkey(hotkey)) return true;
  return Boolean(callback.up) && !electronRegisteredHotkeys.has(hotkey);
}

function isModifierOnlyHotkey(hotkey: string): boolean {
  const tokens = normalizeHotkey(hotkey).split('+').filter(Boolean);
  return tokens.length > 0 && tokens.every(isModifierToken);
}

function syncModifierHotkeyWorker(): void {
  const definitions = [...callbacks.keys()]
    .filter(hotkey => isModifierOnlyHotkey(hotkey) || !electronRegisteredHotkeys.has(hotkey))
    .map(hotkey => ({ hotkey, groups: hotkeyVkGroupsForHotkey(hotkey), fireOnRelease: isModifierOnlyHotkey(hotkey) }))
    .filter((definition): definition is { hotkey: string; groups: HotkeyVkGroup[]; fireOnRelease: boolean } => definition.groups !== null);

  const nextKey = JSON.stringify(definitions);
  if (nextKey === modifierHotkeyWorkerKey) return;

  stopModifierHotkeyWorker();
  modifierHotkeyWorkerKey = nextKey;
  if (definitions.length === 0) return;

  const script = buildModifierHotkeyWorkerScript(definitions);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: 'pipe',
  });

  modifierHotkeyWorker = child;
  child.stdin.end();
  modifierHotkeyWorkerBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => handleModifierHotkeyWorkerOutput(chunk));
  child.once('exit', () => {
    if (modifierHotkeyWorker === child) {
      modifierHotkeyWorker = null;
      modifierHotkeyWorkerKey = '';
    }
  });
  child.once('error', () => {
    if (modifierHotkeyWorker === child) {
      modifierHotkeyWorker = null;
      modifierHotkeyWorkerKey = '';
    }
  });
}

function stopModifierHotkeyWorker(): void {
  const child = modifierHotkeyWorker;
  modifierHotkeyWorker = null;
  modifierHotkeyWorkerKey = '';
  modifierHotkeyWorkerBuffer = '';
  if (child && !child.killed) child.kill();
}

function handleModifierHotkeyWorkerOutput(chunk: string): void {
  modifierHotkeyWorkerBuffer += chunk;

  for (;;) {
    const lineEnd = modifierHotkeyWorkerBuffer.indexOf('\n');
    if (lineEnd < 0) return;

    const line = modifierHotkeyWorkerBuffer.slice(0, lineEnd).trim();
    modifierHotkeyWorkerBuffer = modifierHotkeyWorkerBuffer.slice(lineEnd + 1);
    if (!line.startsWith('HOTKEY ')) continue;

    try {
      const hotkey = Buffer.from(line.slice('HOTKEY '.length), 'base64').toString('utf8');
      fireHotkeyDown(hotkey, false);
      releaseHotkey(hotkey);
    } catch {
      // Ignore malformed worker output.
    }
  }
}

function hotkeyVkGroupsForHotkey(hotkey: string): HotkeyVkGroup[] | null {
  const groups = normalizeHotkey(hotkey).split('+').filter(Boolean).map(token => {
    const letter = token.match(/^[a-z]$/)?.[0];
    if (letter) return [letter.toUpperCase().charCodeAt(0)];

    const digit = token.match(/^[0-9]$/)?.[0];
    if (digit) return [digit.charCodeAt(0)];

    const functionKey = token.match(/^f(\d{1,2})$/)?.[1];
    if (functionKey) return [0x6f + Number(functionKey)];

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

function buildModifierHotkeyWorkerScript(definitions: Array<{ hotkey: string; groups: HotkeyVkGroup[]; fireOnRelease: boolean }>): string {
  const encodedDefinitions = Buffer.from(JSON.stringify(definitions), 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = "Stop"
$defsJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDefinitions}'))
$definitions = @($defsJson | ConvertFrom-Json)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinUtilsModifierKeys {
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScan(char ch);

  public static int[][] ChordForChar(string text) {
    if (String.IsNullOrEmpty(text)) return null;
    short chord = VkKeyScan(text[0]);
    if (chord == -1) return null;

    int vk = chord & 0xff;
    int shiftState = (chord >> 8) & 0xff;
    System.Collections.Generic.List<int[]> groups = new System.Collections.Generic.List<int[]>();
    if ((shiftState & 1) != 0) groups.Add(new int[] { 0x10 });
    if ((shiftState & 2) != 0) groups.Add(new int[] { 0x11 });
    if ((shiftState & 4) != 0) groups.Add(new int[] { 0x12 });
    groups.Add(new int[] { vk });
    return groups.ToArray();
  }

  public static bool AnyPressed(int[] keys) {
    foreach (int key in keys) {
      if ((GetAsyncKeyState(key) & unchecked((short)0x8000)) != 0) return true;
    }
    return false;
  }
  public static bool AnyNonModifierPressed() {
    for (int key = 7; key <= 254; key++) {
      if (key == 0x10 || key == 0x11 || key == 0x12 || key == 0x5B || key == 0x5C) continue;
      if ((GetAsyncKeyState(key) & unchecked((short)0x8000)) != 0) return true;
    }
    return false;
  }
}
'@

function Resolve-DefinitionGroups($definition) {
  $resolved = New-Object System.Collections.ArrayList
  foreach ($group in @($definition.groups)) {
    if ($null -ne $group.char) {
      $chordGroups = [WinUtilsModifierKeys]::ChordForChar($group.char.ToString())
      if ($null -eq $chordGroups) { return $null }
      foreach ($chordGroup in @($chordGroups)) { [void]$resolved.Add([int[]]@($chordGroup)) }
      continue
    }

    [void]$resolved.Add([int[]]@($group))
  }

  return @($resolved)
}

$resolvedDefinitions = @()
foreach ($definition in $definitions) {
  $resolvedGroups = Resolve-DefinitionGroups $definition
  if ($null -eq $resolvedGroups) { continue }
  $resolvedDefinitions += [pscustomobject]@{
    hotkey = $definition.hotkey.ToString()
    groups = $resolvedGroups
    fireOnRelease = [bool]$definition.fireOnRelease
  }
}

$states = @{}
foreach ($definition in $resolvedDefinitions) {
  $states[$definition.hotkey.ToString()] = [pscustomobject]@{ Active = $false; Contaminated = $false }
}

function Test-DefinitionDown($definition) {
  foreach ($group in @($definition.groups)) {
    $keys = [int[]]@($group)
    if (-not [WinUtilsModifierKeys]::AnyPressed($keys)) { return $false }
  }
  return $true
}

while ($true) {
  $otherPressed = [WinUtilsModifierKeys]::AnyNonModifierPressed()
  foreach ($definition in $resolvedDefinitions) {
    $hotkey = $definition.hotkey.ToString()
    $state = $states[$hotkey]
    $isDown = Test-DefinitionDown $definition
    $fireOnRelease = [bool]$definition.fireOnRelease

    if (-not $state.Active -and $isDown) {
      $state.Active = $true
      $state.Contaminated = $false
      if (-not $fireOnRelease) {
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($hotkey))
        [Console]::Out.WriteLine("HOTKEY " + $encoded)
        [Console]::Out.Flush()
      }
      continue
    }

    if ($state.Active -and $isDown) {
      if ($fireOnRelease -and $otherPressed) { $state.Contaminated = $true }
      continue
    }

    if ($state.Active -and -not $isDown) {
      if ($fireOnRelease -and -not $state.Contaminated) {
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($hotkey))
        [Console]::Out.WriteLine("HOTKEY " + $encoded)
        [Console]::Out.Flush()
      }
      $state.Active = $false
      $state.Contaminated = $false
    }
  }
  Start-Sleep -Milliseconds 20
}
`;
}

function startUiohook(module: UiohookModule): void {
  if (uiohookRunning) return;

  try {
    module.uIOhook.on('keydown', handleUiohookKeyDown);
    module.uIOhook.on('keyup', handleUiohookKeyUp);
    module.uIOhook.start();
    uiohookRunning = true;
  } catch {
    try { module.uIOhook.removeListener('keydown', handleUiohookKeyDown); } catch { /* ignore cleanup */ }
    try { module.uIOhook.removeListener('keyup', handleUiohookKeyUp); } catch { /* ignore cleanup */ }
    uiohookRunning = false;
  }
}

function stopUiohook(): void {
  const module = getUiohookModule();
  if (!module || !uiohookRunning) return;

  releaseAllPressedHotkeys();
  try { module.uIOhook.removeListener('keydown', handleUiohookKeyDown); } catch { /* ignore stale listener */ }
  try { module.uIOhook.removeListener('keyup', handleUiohookKeyUp); } catch { /* ignore stale listener */ }
  try { module.uIOhook.stop(); } catch { /* ignore stale hook */ }
  uiohookRunning = false;
}

function toUiohookCombo(hotkey: string, keys: Record<string, number>): UiohookCombo | null {
  const tokens = normalizeHotkey(hotkey).split('+').filter(Boolean);
  if (tokens.length === 0) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let keycodes: number[] = [];

  for (const token of tokens) {
    if (token === 'ctrl' || token === 'control') {
      ctrl = true;
      continue;
    }
    if (token === 'alt') {
      alt = true;
      continue;
    }
    if (token === 'shift') {
      shift = true;
      continue;
    }
    if (token === 'win' || token === 'meta' || token === 'super') {
      meta = true;
      continue;
    }

    const mapped = toUiohookKeycode(token, keys);
    if (mapped !== null) keycodes = [mapped];
  }

  let triggerModifier: UiohookCombo['triggerModifier'] = null;
  if (keycodes.length === 0) {
    const modifierTriggers: Array<{ name: NonNullable<UiohookCombo['triggerModifier']>; codes: number[] }> = [
      { name: 'ctrl', codes: [keys.Ctrl, keys.CtrlRight].filter((value): value is number => typeof value === 'number') },
      { name: 'alt', codes: [keys.Alt, keys.AltRight].filter((value): value is number => typeof value === 'number') },
      { name: 'shift', codes: [keys.Shift, keys.ShiftRight].filter((value): value is number => typeof value === 'number') },
      { name: 'meta', codes: [keys.Meta, keys.MetaRight].filter((value): value is number => typeof value === 'number') },
    ];

    const requestedTriggers = modifierTriggers.filter(item => (
      (item.name === 'ctrl' && ctrl)
      || (item.name === 'alt' && alt)
      || (item.name === 'shift' && shift)
      || (item.name === 'meta' && meta)
    ));

    if (requestedTriggers.length !== 1 || requestedTriggers[0].codes.length === 0) return null;
    triggerModifier = requestedTriggers[0].name;
    keycodes = requestedTriggers[0].codes;
  }

  const modifierKeycodes = [
    ctrl ? keys.Ctrl : null,
    ctrl ? keys.CtrlRight : null,
    alt ? keys.Alt : null,
    alt ? keys.AltRight : null,
    shift ? keys.Shift : null,
    shift ? keys.ShiftRight : null,
    meta ? keys.Meta : null,
    meta ? keys.MetaRight : null,
  ].filter((value): value is number => typeof value === 'number');

  return { hotkey, keycodes, ctrl, alt, shift, meta, modifierKeycodes, triggerModifier };
}

function toUiohookKeycode(token: string, keys: Record<string, number>): number | null {
  const letter = token.match(/^[a-z]$/)?.[0];
  if (letter) return keys[letter.toUpperCase()] ?? null;

  const digit = token.match(/^[0-9]$/)?.[0];
  if (digit) return keys[digit] ?? null;

  const functionKey = token.match(/^f(\d{1,2})$/)?.[1];
  if (functionKey) return keys[`F${functionKey}`] ?? null;

  const numpadDigit = token.match(/^(?:num|numpad)([0-9])$/)?.[1];
  if (numpadDigit) return keys[`Numpad${numpadDigit}`] ?? null;

  switch (token) {
    case 'space': return keys.Space ?? null;
    case 'escape':
    case 'esc': return keys.Escape ?? null;
    case 'enter':
    case 'return': return keys.Enter ?? null;
    case 'tab': return keys.Tab ?? null;
    case 'backspace': return keys.Backspace ?? null;
    case 'delete':
    case 'del': return keys.Delete ?? null;
    case 'insert':
    case 'ins': return keys.Insert ?? null;
    case 'left':
    case 'arrowleft': return keys.ArrowLeft ?? null;
    case 'right':
    case 'arrowright': return keys.ArrowRight ?? null;
    case 'up':
    case 'arrowup': return keys.ArrowUp ?? null;
    case 'down':
    case 'arrowdown': return keys.ArrowDown ?? null;
    case 'home': return keys.Home ?? null;
    case 'end': return keys.End ?? null;
    case 'pageup':
    case 'pgup': return keys.PageUp ?? null;
    case 'pagedown':
    case 'pgdn': return keys.PageDown ?? null;
    case 'numlock':
    case 'num-lock': return keys.NumLock ?? null;
    case 'scrolllock':
    case 'scroll-lock': return keys.ScrollLock ?? null;
    case 'printscreen':
    case 'print-screen': return keys.PrintScreen ?? null;
    case 'numdec':
    case 'numdecimal':
    case 'numpaddecimal': return keys.NumpadDecimal ?? null;
    case 'numadd':
    case 'numpadadd': return keys.NumpadAdd ?? null;
    case 'numsub':
    case 'numsubtract':
    case 'numpadsubtract': return keys.NumpadSubtract ?? null;
    case 'nummult':
    case 'nummultiply':
    case 'numpadmultiply': return keys.NumpadMultiply ?? null;
    case 'numdiv':
    case 'numdivide':
    case 'numpaddivide': return keys.NumpadDivide ?? null;
    case 'semicolon':
    case ';': return keys.Semicolon ?? null;
    case 'equal':
    case '=': return keys.Equal ?? null;
    case 'comma':
    case ',': return keys.Comma ?? null;
    case 'minus':
    case '-': return keys.Minus ?? null;
    case 'period':
    case '.': return keys.Period ?? null;
    case 'slash':
    case '/': return keys.Slash ?? null;
    case 'backquote':
    case '`': return keys.Backquote ?? null;
    case 'bracketleft':
    case '[': return keys.BracketLeft ?? null;
    case 'backslash':
    case '\\': return keys.Backslash ?? null;
    case 'bracketright':
    case ']': return keys.BracketRight ?? null;
    case 'quote':
    case "'": return keys.Quote ?? null;
    default: return null;
  }
}

function handleUiohookKeyDown(event: UiohookKeyboardEvent): void {
  let matchedStandaloneModifier = false;

  for (const combo of uiohookCombos.values()) {
    if (!matchesCombo(event, combo)) continue;

    if (isStandaloneModifierCombo(combo)) {
      pendingStandaloneModifierHotkeys.add(combo.hotkey);
      matchedStandaloneModifier = true;
      continue;
    }

    if (pressedHotkeys.has(combo.hotkey)) return;

    pendingStandaloneModifierHotkeys.clear();

    if (!electronRegisteredHotkeys.has(combo.hotkey)) {
      pressedHotkeys.add(combo.hotkey);
      fireHotkeyDown(combo.hotkey, false);
    }
    return;
  }

  if (!matchedStandaloneModifier && pendingStandaloneModifierHotkeys.size > 0 && !isKnownModifierKeycode(event.keycode)) {
    pendingStandaloneModifierHotkeys.clear();
  }
}

function handleUiohookKeyUp(event: UiohookKeyboardEvent): void {
  for (const combo of uiohookCombos.values()) {
    if (!pressedHotkeys.has(combo.hotkey)) continue;
    if (!combo.keycodes.includes(event.keycode) && !combo.modifierKeycodes.includes(event.keycode)) continue;
    releaseHotkey(combo.hotkey);
  }

  for (const combo of uiohookCombos.values()) {
    if (!pendingStandaloneModifierHotkeys.has(combo.hotkey)) continue;
    if (!combo.keycodes.includes(event.keycode)) continue;

    pendingStandaloneModifierHotkeys.delete(combo.hotkey);
    if (electronRegisteredHotkeys.has(combo.hotkey)) continue;

    pressedHotkeys.add(combo.hotkey);
    fireHotkeyDown(combo.hotkey, false);
    releaseHotkey(combo.hotkey);
  }
}

function isStandaloneModifierCombo(combo: UiohookCombo): boolean {
  return combo.triggerModifier !== null;
}

function isKnownModifierKeycode(keycode: number): boolean {
  for (const combo of uiohookCombos.values()) {
    if (combo.modifierKeycodes.includes(keycode)) return true;
    if (isStandaloneModifierCombo(combo) && combo.keycodes.includes(keycode)) return true;
  }

  return false;
}

function matchesCombo(event: UiohookKeyboardEvent, combo: UiohookCombo): boolean {
  return combo.keycodes.includes(event.keycode)
    && modifierStateMatches(event.ctrlKey, combo.ctrl, combo.triggerModifier === 'ctrl')
    && modifierStateMatches(event.altKey, combo.alt, combo.triggerModifier === 'alt')
    && modifierStateMatches(event.shiftKey, combo.shift, combo.triggerModifier === 'shift')
    && modifierStateMatches(event.metaKey, combo.meta, combo.triggerModifier === 'meta');
}

function modifierStateMatches(actual: boolean, expected: boolean, isTriggerKey: boolean): boolean {
  return isTriggerKey ? true : actual === expected;
}

function fireHotkeyDown(hotkey: string, fromElectron: boolean): void {
  const callback = callbacks.get(hotkey);
  if (!callback) return;
  const canTrackRelease = uiohookRunning && uiohookCombos.has(hotkey);

  if (fromElectron && canTrackRelease) {
    if (pressedHotkeys.has(hotkey)) return;
    pressedHotkeys.add(hotkey);
  }

  try { callback.down(); } catch { /* ignore callback crash */ }

  if (callback.up && !canTrackRelease) {
    setTimeout(() => releaseHotkey(hotkey), 0);
  }
}

function releaseHotkey(hotkey: string): void {
  const callback = callbacks.get(hotkey);
  pressedHotkeys.delete(hotkey);
  if (!callback?.up) return;
  try { callback.up(); } catch { /* ignore callback crash */ }
}

function releaseAllPressedHotkeys(): void {
  pendingStandaloneModifierHotkeys.clear();
  for (const hotkey of [...pressedHotkeys]) {
    releaseHotkey(hotkey);
  }
  pressedHotkeys.clear();
}

export function registerHotkey(hotkey: string, callback: (() => void) | HotkeyCallbacks): void {
  callbacks.set(normalizeHotkey(hotkey), toCallbacks(callback));
  if (hooked) registerAllHotkeys();
}

export function replaceHotkeys(entries: Array<{ hotkey: string; callback: (() => void) | HotkeyCallbacks }>): void {
  releaseAllPressedHotkeys();
  callbacks.clear();

  for (const entry of entries) {
    callbacks.set(normalizeHotkey(entry.hotkey), toCallbacks(entry.callback));
  }

  if (hooked) registerAllHotkeys();
}

export function unregisterHotkey(hotkey: string): void {
  const normalized = normalizeHotkey(hotkey);
  pendingStandaloneModifierHotkeys.delete(normalized);
  releaseHotkey(normalized);
  callbacks.delete(normalized);
  if (hooked) registerAllHotkeys();
}

export function clearHotkeys(): void {
  releaseAllPressedHotkeys();
  callbacks.clear();
  stopModifierHotkeyWorker();
  if (hooked) {
    unregisterRegisteredHotkeys();
    syncUiohook();
  }
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
  releaseAllPressedHotkeys();
  unregisterRegisteredHotkeys();
  stopUiohook();
  stopModifierHotkeyWorker();
  hooked = false;
}
