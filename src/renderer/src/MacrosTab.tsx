import type { CSSProperties, DragEvent, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeMacroPlayback } from '../../shared/macro';
import type {
  CommandAction,
  DelayAction,
  IfAction,
  KeyboardAction,
  LaunchAction,
  Macro,
  MacroAction,
  MacroCondition,
  MacroConditionOperator,
  MacroConditionSource,
  MacroFolder,
  MacroHotkeyConflict,
  MacroHotkeySuggestion,
  MacroPlaybackMode,
  MacroPlaybackOptions,
  MacroProfile,
  MacroRuntimeStats,
  MacroState,
  MouseAction,
  RepeatAction,
  TextAction,
} from '../../shared/macro';

// ─── Helpers ──────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function blankMacro(name = 'New Macro'): Macro {
  return { id: newId(), name, hotkey: '', actions: [], enabled: true, playback: normalizeMacroPlayback(undefined) };
}

function blankFolder(name = 'New Folder'): MacroFolder {
  return { id: newId(), name, macros: [], isExpanded: true };
}

function normalizeMacroHotkey(hotkey: string): string {
  return hotkey.trim().toLowerCase().replace(/\s+/g, '');
}

function blankCondition(): MacroCondition {
  return { source: 'active-process', operator: 'contains', value: '', caseSensitive: false };
}

function blankAction(type: MacroAction['type']): MacroAction {
  switch (type) {
    case 'delay': return { id: newId(), type: 'delay', enabled: true, milliseconds: 500 };
    case 'keyboard': return { id: newId(), type: 'keyboard', enabled: true, key: 'Enter', pressType: 'press' };
    case 'mouse': return { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'click' };
    case 'launch': return { id: newId(), type: 'launch', enabled: true, path: '', arguments: '' };
    case 'command': return { id: newId(), type: 'command', enabled: true, command: '', workingDirectory: '' };
    case 'text': return { id: newId(), type: 'text', enabled: true, text: '' };
    case 'repeat': return { id: newId(), type: 'repeat', enabled: true, times: 10, actions: [] };
    case 'if': return { id: newId(), type: 'if', enabled: true, condition: blankCondition(), thenActions: [], elseActions: [] };
  }
}

function keyboardHoldReleaseActions(key: string): MacroAction[] {
  return [
    { id: newId(), type: 'delay', enabled: true, milliseconds: 100 },
    { id: newId(), type: 'keyboard', enabled: true, key, pressType: 'up' },
  ];
}

function updateActionAt(actions: MacroAction[], index: number, updated: MacroAction, insertAfter: MacroAction[] = []): MacroAction[] {
  const previous = actions[index];
  const next = actions.flatMap((action, actionIndex) => (
    actionIndex === index ? [updated, ...insertAfter] : [action]
  ));

  if (
    previous?.type === 'keyboard'
    && updated.type === 'keyboard'
    && previous.pressType === 'down'
    && updated.pressType === 'down'
    && previous.key !== updated.key
    && insertAfter.length === 0
  ) {
    const delayAction = next[index + 1];
    const keyUpAction = next[index + 2];
    if (delayAction?.type === 'delay' && keyUpAction?.type === 'keyboard' && keyUpAction.pressType === 'up' && keyUpAction.key === previous.key) {
      next[index + 2] = { ...keyUpAction, key: updated.key };
    }
  }

  return next;
}

function captureKeyName(event: React.KeyboardEvent<HTMLInputElement>): string {
  const numpadKey = captureNumpadKeyName(event.code);
  if (numpadKey) return numpadKey;

  if (event.key === 'Control') return 'Ctrl';
  if (event.key === 'Alt') return 'Alt';
  if (event.key === 'Shift') return 'Shift';
  if (event.key === 'Meta' || event.key === 'OS') return 'Win';
  if (event.key === 'Enter') return 'Enter';
  if (event.key === 'ArrowLeft') return 'Left';
  if (event.key === 'ArrowRight') return 'Right';
  if (event.key === 'ArrowUp') return 'Up';
  if (event.key === 'ArrowDown') return 'Down';
  if (event.key === ' ') return 'Space';
  if (event.key.length === 1) return event.key.toUpperCase();

  return event.key;
}

function capturePhysicalKeyName(code: string): string | null {
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;

  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;

  const functionKey = code.match(/^F(\d{1,2})$/)?.[1];
  if (functionKey) return `F${functionKey}`;

  switch (code) {
    case 'Space': return 'Space';
    case 'Enter':
    case 'NumpadEnter': return 'Enter';
    case 'Escape': return 'Escape';
    case 'Tab': return 'Tab';
    case 'Backspace': return 'Backspace';
    case 'Delete': return 'Delete';
    case 'Insert': return 'Insert';
    case 'ArrowLeft': return 'Left';
    case 'ArrowRight': return 'Right';
    case 'ArrowUp': return 'Up';
    case 'ArrowDown': return 'Down';
    case 'Home': return 'Home';
    case 'End': return 'End';
    case 'PageUp': return 'PageUp';
    case 'PageDown': return 'PageDown';
    case 'Semicolon': return 'Semicolon';
    case 'Equal': return 'Equal';
    case 'Comma': return 'Comma';
    case 'Minus': return 'Minus';
    case 'Period': return 'Period';
    case 'Slash': return 'Slash';
    case 'Backquote': return 'Backquote';
    case 'BracketLeft': return 'BracketLeft';
    case 'Backslash':
    case 'IntlBackslash': return 'Backslash';
    case 'BracketRight': return 'BracketRight';
    case 'Quote': return 'Quote';
    default: return null;
  }
}

function isCapturedModifierKey(key: string): boolean {
  return key === 'Ctrl' || key === 'Alt' || key === 'Shift' || key === 'Win';
}

function captureNumpadKeyName(code: string): string | null {
  const digit = code.match(/^Numpad([0-9])$/)?.[1];
  if (digit) return `Num${digit}`;

  switch (code) {
    case 'NumpadDecimal': return 'NumDec';
    case 'NumpadAdd': return 'NumAdd';
    case 'NumpadSubtract': return 'NumSub';
    case 'NumpadMultiply': return 'NumMult';
    case 'NumpadDivide': return 'NumDiv';
    case 'NumpadEnter': return 'Enter';
    default: return null;
  }
}

function actionLabel(a: MacroAction): string {
  switch (a.type) {
    case 'delay': return `Delay ${a.milliseconds} ms`;
    case 'keyboard': return `${a.pressType} ${a.key}`;
    case 'mouse': return `${a.button} ${a.actionType}${a.x !== undefined ? ` (${a.x},${a.y})` : ''}`;
    case 'launch': return `Launch ${a.path.split(/[\\/]/).pop() ?? a.path}`;
    case 'command': return `Run: ${a.command.slice(0, 40)}`;
    case 'text': return `Type: ${a.text.slice(0, 30)}`;
    case 'repeat': return `Repeat ${a.times}x`;
    case 'if': return `If ${conditionSourceLabels[a.condition.source]}`;
    default: return '';
  }
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  if (diffMs < 1000) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const macroActionDescriptions: Record<MacroAction['type'], string> = {
  delay: 'Wait for a number of milliseconds before running the next action.',
  keyboard: 'Send a keyboard key or key combination.',
  mouse: 'Click, hold, release, or move the mouse.',
  launch: 'Start an app or executable file.',
  command: 'Run a PowerShell command.',
  text: 'Type text into the focused window.',
  repeat: 'Run a nested action group a fixed number of times.',
  if: 'Run one branch or another when a condition matches.',
};

const actionTypes: MacroAction['type'][] = ['delay', 'keyboard', 'mouse', 'text', 'repeat', 'if', 'launch', 'command'];

const conditionSourceLabels: Record<MacroConditionSource, string> = {
  'active-process': 'Active process',
  'active-window-title': 'Active window title',
  'clipboard-text': 'Clipboard text',
  'file-exists': 'File path',
  'key-state': 'Key state',
};

const conditionOperatorLabels: Record<MacroConditionOperator, string> = {
  contains: 'Contains',
  equals: 'Equals',
  matches: 'Regex matches',
  'not-contains': 'Does not contain',
  'not-equals': 'Does not equal',
  'not-matches': 'Regex does not match',
  exists: 'Exists',
  'not-exists': 'Does not exist',
  'is-pressed': 'Is pressed',
  'is-not-pressed': 'Is not pressed',
};

const textConditionOperators: MacroConditionOperator[] = ['contains', 'equals', 'matches', 'not-contains', 'not-equals', 'not-matches'];
const fileConditionOperators: MacroConditionOperator[] = ['exists', 'not-exists'];
const keyConditionOperators: MacroConditionOperator[] = ['is-pressed', 'is-not-pressed'];

const macroPlaybackModes: MacroPlaybackMode[] = ['once', 'multiple', 'toggle', 'while-pressed', 'queue'];

const macroPlaybackLabels: Record<MacroPlaybackMode, string> = {
  once: 'Play once',
  multiple: 'Play multiple times',
  toggle: 'Toggle continuous playback on/off',
  'while-pressed': 'Play while assigned key is pressed',
  queue: 'Queue',
};

const macroPlaybackDescriptions: Record<MacroPlaybackMode, string> = {
  once: 'Runs the macro once when the hotkey is pressed.',
  multiple: 'Runs the macro a fixed number of times when the hotkey is pressed.',
  toggle: 'Starts or stops a continuous macro loop each time the hotkey is pressed.',
  'while-pressed': 'Loops the macro while the assigned hotkey is held down.',
  queue: 'Adds another macro run to the queue each time the hotkey is pressed.',
};

interface MacroPreset {
  id: string;
  label: string;
  description: string;
  createActions: (options: MacroPresetOptions) => MacroAction[];
}

const ROOT_ACTION_LIST_ID = 'root';

type NestedActionListBranch = 'actions' | 'then' | 'else';

interface ActionDragSource {
  actionId: string;
  listId: string;
  index: number;
}

interface ActionDropTarget {
  listId: string;
  index: number;
}

interface ActionDragController {
  dragSource: ActionDragSource | null;
  dropTarget: ActionDropTarget | null;
  startDrag: (source: ActionDragSource) => void;
  previewDrop: (target: ActionDropTarget | null) => void;
  dropAction: (target: ActionDropTarget) => void;
  endDrag: () => void;
}

type KeyboardPreviewLayoutId = 'ansi-full' | 'ansi-tkl' | 'ansi-60';

interface KeyboardPreviewKey {
  id: string;
  label: string;
  width?: number;
  aliases?: string[];
  spacer?: boolean;
}

interface KeyboardPreviewLayout {
  id: KeyboardPreviewLayoutId;
  label: string;
  rows: KeyboardPreviewKey[][];
}

interface HotkeyKeyBinding {
  macroId: string;
  macroName: string;
  hotkey: string;
  enabled: boolean;
  modifiers: string[];
}

const KEYBOARD_PREVIEW_ENABLED_STORAGE_KEY = 'winutils.macros.keyboardPreview.enabled';
const KEYBOARD_PREVIEW_LAYOUT_STORAGE_KEY = 'winutils.macros.keyboardPreview.layout';

const keyboardModifierTokens = new Set(['ctrl', 'alt', 'shift', 'win']);

function keyDef(id: string, label: string, width = 1, aliases: string[] = []): KeyboardPreviewKey {
  return { id, label, width, aliases };
}

function spacer(width = 0.5): KeyboardPreviewKey {
  return { id: `spacer-${newId()}`, label: '', width, spacer: true };
}

const keyboardPreviewLayouts: Record<KeyboardPreviewLayoutId, KeyboardPreviewLayout> = {
  'ansi-full': {
    id: 'ansi-full',
    label: 'ANSI Full Size',
    rows: [
      [keyDef('escape', 'Esc', 1.1, ['esc']), spacer(0.4), keyDef('f1', 'F1'), keyDef('f2', 'F2'), keyDef('f3', 'F3'), keyDef('f4', 'F4'), spacer(0.3), keyDef('f5', 'F5'), keyDef('f6', 'F6'), keyDef('f7', 'F7'), keyDef('f8', 'F8'), spacer(0.3), keyDef('f9', 'F9'), keyDef('f10', 'F10'), keyDef('f11', 'F11'), keyDef('f12', 'F12'), spacer(0.6), keyDef('printscreen', 'PrtSc', 1.2, ['prtsc']), keyDef('insert', 'Ins', 1.1, ['ins']), keyDef('home', 'Home', 1.1), keyDef('pageup', 'PgUp', 1.1, ['pgup']), spacer(0.6), keyDef('numlock', 'Num', 1.1), keyDef('numdiv', 'N /', 1.1, ['num/']), keyDef('nummult', 'N *', 1.1, ['num*']), keyDef('numsub', 'N -', 1.1, ['num-'])],
      [keyDef('backquote', '`', 1.1, ['`']), keyDef('1', '1'), keyDef('2', '2'), keyDef('3', '3'), keyDef('4', '4'), keyDef('5', '5'), keyDef('6', '6'), keyDef('7', '7'), keyDef('8', '8'), keyDef('9', '9'), keyDef('0', '0'), keyDef('minus', '-', 1.1, ['-']), keyDef('equal', '=', 1.1, ['=']), keyDef('backspace', 'Backspace', 2, ['bksp']), spacer(0.6), keyDef('delete', 'Del', 1.1, ['del']), keyDef('end', 'End', 1.1), keyDef('pagedown', 'PgDn', 1.1, ['pgdn']), spacer(0.6), keyDef('num7', 'N 7', 1.1), keyDef('num8', 'N 8', 1.1), keyDef('num9', 'N 9', 1.1), keyDef('numadd', 'N +', 1.1, ['num+'])],
      [keyDef('tab', 'Tab', 1.6), keyDef('q', 'Q'), keyDef('w', 'W'), keyDef('e', 'E'), keyDef('r', 'R'), keyDef('t', 'T'), keyDef('y', 'Y'), keyDef('u', 'U'), keyDef('i', 'I'), keyDef('o', 'O'), keyDef('p', 'P'), keyDef('bracketleft', '[', 1.1, ['[']), keyDef('bracketright', ']', 1.1, [']']), keyDef('backslash', '\\', 1.5, ['|']), spacer(4), keyDef('num4', 'N 4', 1.1), keyDef('num5', 'N 5', 1.1), keyDef('num6', 'N 6', 1.1)],
      [keyDef('capslock', 'Caps', 1.9, ['caps']), keyDef('a', 'A'), keyDef('s', 'S'), keyDef('d', 'D'), keyDef('f', 'F'), keyDef('g', 'G'), keyDef('h', 'H'), keyDef('j', 'J'), keyDef('k', 'K'), keyDef('l', 'L'), keyDef('semicolon', ';', 1.1, [';']), keyDef('quote', "'", 1.1, ["'"]), keyDef('enter', 'Enter', 2.2, ['return']), spacer(4), keyDef('num1', 'N 1', 1.1), keyDef('num2', 'N 2', 1.1), keyDef('num3', 'N 3', 1.1), keyDef('numenter', 'N Enter', 1.1)],
      [keyDef('shift-left', 'Shift', 2.3, ['shift']), keyDef('z', 'Z'), keyDef('x', 'X'), keyDef('c', 'C'), keyDef('v', 'V'), keyDef('b', 'B'), keyDef('n', 'N'), keyDef('m', 'M'), keyDef('comma', ',', 1.1, [',']), keyDef('period', '.', 1.1, ['.']), keyDef('slash', '/', 1.1, ['/']), keyDef('shift-right', 'Shift', 2.8, ['shift']), spacer(1.2), keyDef('up', '↑', 1.1, ['arrowup']), spacer(1.7), keyDef('num0', 'N 0', 2.3), keyDef('numdec', 'N .', 1.1, ['num.'])],
      [keyDef('ctrl-left', 'Ctrl', 1.4, ['ctrl', 'control']), keyDef('win-left', 'Win', 1.3, ['meta']), keyDef('alt-left', 'Alt', 1.3, ['option']), keyDef('space', 'Space', 6), keyDef('alt-right', 'Alt', 1.3, ['option']), keyDef('fn', 'Fn', 1.2), keyDef('menu', 'Menu', 1.2), keyDef('ctrl-right', 'Ctrl', 1.4, ['ctrl', 'control']), spacer(0.5), keyDef('left', '←', 1.1, ['arrowleft']), keyDef('down', '↓', 1.1, ['arrowdown']), keyDef('right', '→', 1.1, ['arrowright'])],
    ],
  },
  'ansi-tkl': {
    id: 'ansi-tkl',
    label: 'ANSI TKL',
    rows: [
      [keyDef('escape', 'Esc', 1.1, ['esc']), spacer(0.4), keyDef('f1', 'F1'), keyDef('f2', 'F2'), keyDef('f3', 'F3'), keyDef('f4', 'F4'), spacer(0.3), keyDef('f5', 'F5'), keyDef('f6', 'F6'), keyDef('f7', 'F7'), keyDef('f8', 'F8'), spacer(0.3), keyDef('f9', 'F9'), keyDef('f10', 'F10'), keyDef('f11', 'F11'), keyDef('f12', 'F12'), spacer(0.6), keyDef('printscreen', 'PrtSc', 1.2, ['prtsc']), keyDef('insert', 'Ins', 1.1, ['ins']), keyDef('home', 'Home', 1.1), keyDef('pageup', 'PgUp', 1.1, ['pgup'])],
      [keyDef('backquote', '`', 1.1, ['`']), keyDef('1', '1'), keyDef('2', '2'), keyDef('3', '3'), keyDef('4', '4'), keyDef('5', '5'), keyDef('6', '6'), keyDef('7', '7'), keyDef('8', '8'), keyDef('9', '9'), keyDef('0', '0'), keyDef('minus', '-', 1.1, ['-']), keyDef('equal', '=', 1.1, ['=']), keyDef('backspace', 'Backspace', 2, ['bksp']), spacer(0.6), keyDef('delete', 'Del', 1.1, ['del']), keyDef('end', 'End', 1.1), keyDef('pagedown', 'PgDn', 1.1, ['pgdn'])],
      [keyDef('tab', 'Tab', 1.6), keyDef('q', 'Q'), keyDef('w', 'W'), keyDef('e', 'E'), keyDef('r', 'R'), keyDef('t', 'T'), keyDef('y', 'Y'), keyDef('u', 'U'), keyDef('i', 'I'), keyDef('o', 'O'), keyDef('p', 'P'), keyDef('bracketleft', '[', 1.1, ['[']), keyDef('bracketright', ']', 1.1, [']']), keyDef('backslash', '\\', 1.5, ['|'])],
      [keyDef('capslock', 'Caps', 1.9, ['caps']), keyDef('a', 'A'), keyDef('s', 'S'), keyDef('d', 'D'), keyDef('f', 'F'), keyDef('g', 'G'), keyDef('h', 'H'), keyDef('j', 'J'), keyDef('k', 'K'), keyDef('l', 'L'), keyDef('semicolon', ';', 1.1, [';']), keyDef('quote', "'", 1.1, ["'"]), keyDef('enter', 'Enter', 2.2, ['return'])],
      [keyDef('shift-left', 'Shift', 2.3, ['shift']), keyDef('z', 'Z'), keyDef('x', 'X'), keyDef('c', 'C'), keyDef('v', 'V'), keyDef('b', 'B'), keyDef('n', 'N'), keyDef('m', 'M'), keyDef('comma', ',', 1.1, [',']), keyDef('period', '.', 1.1, ['.']), keyDef('slash', '/', 1.1, ['/']), keyDef('shift-right', 'Shift', 2.8, ['shift']), spacer(1.2), keyDef('up', '↑', 1.1, ['arrowup'])],
      [keyDef('ctrl-left', 'Ctrl', 1.4, ['ctrl', 'control']), keyDef('win-left', 'Win', 1.3, ['meta']), keyDef('alt-left', 'Alt', 1.3, ['option']), keyDef('space', 'Space', 6), keyDef('alt-right', 'Alt', 1.3, ['option']), keyDef('fn', 'Fn', 1.2), keyDef('menu', 'Menu', 1.2), keyDef('ctrl-right', 'Ctrl', 1.4, ['ctrl', 'control']), spacer(0.5), keyDef('left', '←', 1.1, ['arrowleft']), keyDef('down', '↓', 1.1, ['arrowdown']), keyDef('right', '→', 1.1, ['arrowright'])],
    ],
  },
  'ansi-60': {
    id: 'ansi-60',
    label: 'ANSI 60%',
    rows: [
      [keyDef('escape', 'Esc', 1.1, ['esc']), keyDef('1', '1'), keyDef('2', '2'), keyDef('3', '3'), keyDef('4', '4'), keyDef('5', '5'), keyDef('6', '6'), keyDef('7', '7'), keyDef('8', '8'), keyDef('9', '9'), keyDef('0', '0'), keyDef('minus', '-', 1.1, ['-']), keyDef('equal', '=', 1.1, ['=']), keyDef('backspace', 'Backspace', 2, ['bksp'])],
      [keyDef('tab', 'Tab', 1.6), keyDef('q', 'Q'), keyDef('w', 'W'), keyDef('e', 'E'), keyDef('r', 'R'), keyDef('t', 'T'), keyDef('y', 'Y'), keyDef('u', 'U'), keyDef('i', 'I'), keyDef('o', 'O'), keyDef('p', 'P'), keyDef('bracketleft', '[', 1.1, ['[']), keyDef('bracketright', ']', 1.1, [']']), keyDef('backslash', '\\', 1.5, ['|'])],
      [keyDef('capslock', 'Caps', 1.9, ['caps']), keyDef('a', 'A'), keyDef('s', 'S'), keyDef('d', 'D'), keyDef('f', 'F'), keyDef('g', 'G'), keyDef('h', 'H'), keyDef('j', 'J'), keyDef('k', 'K'), keyDef('l', 'L'), keyDef('semicolon', ';', 1.1, [';']), keyDef('quote', "'", 1.1, ["'"]), keyDef('enter', 'Enter', 2.2, ['return'])],
      [keyDef('shift-left', 'Shift', 2.3, ['shift']), keyDef('z', 'Z'), keyDef('x', 'X'), keyDef('c', 'C'), keyDef('v', 'V'), keyDef('b', 'B'), keyDef('n', 'N'), keyDef('m', 'M'), keyDef('comma', ',', 1.1, [',']), keyDef('period', '.', 1.1, ['.']), keyDef('slash', '/', 1.1, ['/']), keyDef('shift-right', 'Shift', 2.8, ['shift'])],
      [keyDef('ctrl-left', 'Ctrl', 1.4, ['ctrl', 'control']), keyDef('win-left', 'Win', 1.3, ['meta']), keyDef('alt-left', 'Alt', 1.3, ['option']), keyDef('space', 'Space', 6), keyDef('alt-right', 'Alt', 1.3, ['option']), keyDef('fn', 'Fn', 1.2), keyDef('menu', 'Menu', 1.2), keyDef('ctrl-right', 'Ctrl', 1.4, ['ctrl', 'control'])],
    ],
  },
};

function loadKeyboardPreviewEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(KEYBOARD_PREVIEW_ENABLED_STORAGE_KEY) === '1';
}

function loadKeyboardPreviewLayout(): KeyboardPreviewLayoutId {
  if (typeof window === 'undefined') return 'ansi-full';
  const raw = window.localStorage.getItem(KEYBOARD_PREVIEW_LAYOUT_STORAGE_KEY);
  if (raw === 'ansi-full' || raw === 'ansi-tkl' || raw === 'ansi-60') return raw;
  return 'ansi-full';
}

function normalizeHotkeyToken(token: string): string {
  const normalized = token.trim().toLowerCase().replace(/\s+/g, '').replace(/[_-]/g, '');
  switch (normalized) {
    case 'control':
      return 'ctrl';
    case 'meta':
    case 'windows':
    case 'os':
      return 'win';
    case 'option':
      return 'alt';
    case 'arrowup':
      return 'up';
    case 'arrowdown':
      return 'down';
    case 'arrowleft':
      return 'left';
    case 'arrowright':
      return 'right';
    case 'pageup':
    case 'pgup':
      return 'pageup';
    case 'pagedown':
    case 'pgdn':
      return 'pagedown';
    case 'escape':
      return 'escape';
    case 'return':
      return 'enter';
    case 'ins':
      return 'insert';
    case 'del':
      return 'delete';
    case 'numadd':
    case 'num+':
      return 'numadd';
    case 'numsub':
    case 'num-':
      return 'numsub';
    case 'nummult':
    case 'num*':
      return 'nummult';
    case 'numdiv':
    case 'num/':
      return 'numdiv';
    case 'numdec':
    case 'num.':
      return 'numdec';
    default:
      return normalized;
  }
}

function modifierTokenLabel(token: string): string {
  if (token === 'ctrl') return 'Ctrl';
  if (token === 'alt') return 'Alt';
  if (token === 'shift') return 'Shift';
  if (token === 'win') return 'Win';
  return token.toUpperCase();
}

function buildKeyboardAliasMap(layout: KeyboardPreviewLayout): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const addAlias = (token: string, keyId: string) => {
    const list = aliases.get(token) ?? [];
    if (!list.includes(keyId)) list.push(keyId);
    aliases.set(token, list);
  };

  layout.rows.forEach(row => {
    row.forEach(key => {
      if (key.spacer) return;
      addAlias(normalizeHotkeyToken(key.id), key.id);
      key.aliases?.forEach(alias => addAlias(normalizeHotkeyToken(alias), key.id));
      if (key.label) addAlias(normalizeHotkeyToken(key.label), key.id);
    });
  });

  return aliases;
}

function extractHotkeyBinding(macro: Macro): { binding: HotkeyKeyBinding; primaryToken: string } | null {
  const hotkey = macro.hotkey.trim();
  if (!hotkey) return null;

  const tokens = hotkey.split('+').map(token => normalizeHotkeyToken(token)).filter(Boolean);
  if (tokens.length === 0) return null;

  let resolvedPrimaryIndex = tokens.length - 1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (!keyboardModifierTokens.has(tokens[index])) {
      resolvedPrimaryIndex = index;
      break;
    }
  }
  const primaryToken = tokens[resolvedPrimaryIndex];
  const modifiers = tokens
    .filter((token, index) => index !== resolvedPrimaryIndex && keyboardModifierTokens.has(token))
    .map(modifierTokenLabel);

  return {
    primaryToken,
    binding: {
      macroId: macro.id,
      macroName: macro.name || '(unnamed)',
      hotkey,
      enabled: macro.enabled,
      modifiers,
    },
  };
}

function nestedActionListId(actionId: string, branch: NestedActionListBranch): string {
  return `${actionId}:${branch}`;
}

function insertActionAt(actions: MacroAction[], index: number, action: MacroAction): MacroAction[] {
  const next = [...actions];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, action);
  return next;
}

function removeActionById(actions: MacroAction[], actionId: string): { actions: MacroAction[]; removed: MacroAction | null } {
  const directIndex = actions.findIndex(action => action.id === actionId);
  if (directIndex >= 0) {
    const next = [...actions];
    const [removed] = next.splice(directIndex, 1);
    return { actions: next, removed };
  }

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.type === 'repeat') {
      const result = removeActionById(action.actions, actionId);
      if (result.removed) {
        const next = [...actions];
        next[index] = { ...action, actions: result.actions };
        return { actions: next, removed: result.removed };
      }
    }

    if (action.type === 'if') {
      const thenResult = removeActionById(action.thenActions, actionId);
      if (thenResult.removed) {
        const next = [...actions];
        next[index] = { ...action, thenActions: thenResult.actions };
        return { actions: next, removed: thenResult.removed };
      }

      const elseResult = removeActionById(action.elseActions, actionId);
      if (elseResult.removed) {
        const next = [...actions];
        next[index] = { ...action, elseActions: elseResult.actions };
        return { actions: next, removed: elseResult.removed };
      }
    }
  }

  return { actions, removed: null };
}

function insertActionIntoList(actions: MacroAction[], listId: string, index: number, actionToInsert: MacroAction): { actions: MacroAction[]; inserted: boolean } {
  if (listId === ROOT_ACTION_LIST_ID) return { actions: insertActionAt(actions, index, actionToInsert), inserted: true };

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const action = actions[actionIndex];

    if (action.type === 'repeat') {
      if (listId === nestedActionListId(action.id, 'actions')) {
        const next = [...actions];
        next[actionIndex] = { ...action, actions: insertActionAt(action.actions, index, actionToInsert) };
        return { actions: next, inserted: true };
      }

      const result = insertActionIntoList(action.actions, listId, index, actionToInsert);
      if (result.inserted) {
        const next = [...actions];
        next[actionIndex] = { ...action, actions: result.actions };
        return { actions: next, inserted: true };
      }
    }

    if (action.type === 'if') {
      if (listId === nestedActionListId(action.id, 'then')) {
        const next = [...actions];
        next[actionIndex] = { ...action, thenActions: insertActionAt(action.thenActions, index, actionToInsert) };
        return { actions: next, inserted: true };
      }

      if (listId === nestedActionListId(action.id, 'else')) {
        const next = [...actions];
        next[actionIndex] = { ...action, elseActions: insertActionAt(action.elseActions, index, actionToInsert) };
        return { actions: next, inserted: true };
      }

      const thenResult = insertActionIntoList(action.thenActions, listId, index, actionToInsert);
      if (thenResult.inserted) {
        const next = [...actions];
        next[actionIndex] = { ...action, thenActions: thenResult.actions };
        return { actions: next, inserted: true };
      }

      const elseResult = insertActionIntoList(action.elseActions, listId, index, actionToInsert);
      if (elseResult.inserted) {
        const next = [...actions];
        next[actionIndex] = { ...action, elseActions: elseResult.actions };
        return { actions: next, inserted: true };
      }
    }
  }

  return { actions, inserted: false };
}

function moveActionInTree(actions: MacroAction[], source: ActionDragSource, target: ActionDropTarget): MacroAction[] {
  let targetIndex = target.index;
  if (source.listId === target.listId && targetIndex > source.index) targetIndex -= 1;
  if (source.listId === target.listId && targetIndex === source.index) return actions;

  const removal = removeActionById(actions, source.actionId);
  if (!removal.removed) return actions;

  const insertion = insertActionIntoList(removal.actions, target.listId, targetIndex, removal.removed);
  return insertion.inserted ? insertion.actions : actions;
}

function dropIndexForEvent(event: DragEvent<HTMLElement>, index: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? index : index + 1;
}

function actionDropClass(baseClass: string, listId: string, index: number, dropTarget: ActionDropTarget | null): string {
  const before = dropTarget?.listId === listId && dropTarget.index === index;
  const after = dropTarget?.listId === listId && dropTarget.index === index + 1;
  return `${baseClass}${before ? ` ${baseClass}--drop-before` : ''}${after ? ` ${baseClass}--drop-after` : ''}`;
}

type AutoClickerTimingMode = 'delay' | 'cps';

interface AutoClickerPresetOptions {
  repeatCount: number;
  timingMode: AutoClickerTimingMode;
  delayMs: number;
  clicksPerSecond: number;
}

type HelldiversDirection = 'U' | 'D' | 'L' | 'R';
type HelldiversMovementKeys = 'arrows' | 'wasd';
type HelldiversModifierKey = 'none' | 'Ctrl' | 'Alt' | 'Shift';
type HelldiversModifierBehavior = 'hold' | 'press';

interface HelldiversStratagemPreset {
  id: string;
  name: string;
  code: string;
}

interface HelldiversPresetOptions {
  stratagemId: string;
  movementKeys: HelldiversMovementKeys;
  modifierKey: HelldiversModifierKey;
  modifierBehavior: HelldiversModifierBehavior;
  keyDelayMs: number;
  modifierLeadInMs: number;
}

interface MacroPresetOptions {
  autoClicker: AutoClickerPresetOptions;
  helldivers: HelldiversPresetOptions;
}

const AUTO_CLICKER_CLICK_MS = 0;
const DEFAULT_AUTO_CLICKER_OPTIONS: AutoClickerPresetOptions = {
  repeatCount: 50,
  timingMode: 'delay',
  delayMs: 0,
  clicksPerSecond: 20,
};

const helldivers2StratagemPresets: HelldiversStratagemPreset[] = [
  { id: 'orbital-precision-strike', name: 'Orbital Precision Strike', code: 'RRU' },
  { id: 'orbital-gatling-barrage', name: 'Orbital Gatling Barrage', code: 'RDLUU' },
  { id: 'orbital-airburst-strike', name: 'Orbital Airburst Strike', code: 'RRR' },
  { id: 'orbital-napalm-barrage', name: 'Orbital Napalm Barrage', code: 'RRDLRU' },
  { id: 'orbital-120mm-he-barrage', name: 'Orbital 120MM HE Barrage', code: 'RRDLRD' },
  { id: 'orbital-walking-barrage', name: 'Orbital Walking Barrage', code: 'RDRDRD' },
  { id: 'orbital-380mm-he-barrage', name: 'Orbital 380MM HE Barrage', code: 'RDUULDD' },
  { id: 'orbital-railcannon-strike', name: 'Orbital Railcannon Strike', code: 'RUDDR' },
  { id: 'orbital-laser', name: 'Orbital Laser', code: 'RDURD' },
  { id: 'orbital-ems-strike', name: 'Orbital EMS Strike', code: 'RRLD' },
  { id: 'orbital-gas-strike', name: 'Orbital Gas Strike', code: 'RRDR' },
  { id: 'orbital-smoke-strike', name: 'Orbital Smoke Strike', code: 'RRDU' },
  { id: 'eagle-500kg-bomb', name: 'Eagle 500kg Bomb', code: 'URDDD' },
  { id: 'eagle-strafing-run', name: 'Eagle Strafing Run', code: 'URR' },
  { id: 'eagle-110mm-rocket-pods', name: 'Eagle 110MM Rocket Pods', code: 'URUL' },
  { id: 'eagle-airstrike', name: 'Eagle Airstrike', code: 'URDR' },
  { id: 'eagle-cluster-bomb', name: 'Eagle Cluster Bomb', code: 'URDDR' },
  { id: 'eagle-napalm-airstrike', name: 'Eagle Napalm Airstrike', code: 'URDU' },
  { id: 'eagle-smoke-strike', name: 'Eagle Smoke Strike', code: 'URUD' },
  { id: 'cqc-1-one-true-flag', name: 'CQC-1 One True Flag', code: 'DLRRU' },
  { id: 'mg-43-machine-gun', name: 'MG-43 Machine Gun', code: 'DLDUR' },
  { id: 'm-105-stalwart', name: 'M-105 Stalwart', code: 'DLDUUL' },
  { id: 'mg-206-heavy-machine-gun', name: 'MG-206 Heavy Machine Gun', code: 'DLUDD' },
  { id: 'rs-422-railgun', name: 'RS-422 Railgun', code: 'DRDULR' },
  { id: 'apw-1-anti-materiel-rifle', name: 'APW-1 Anti-Materiel Rifle', code: 'DLRUD' },
  { id: 'gl-21-grenade-launcher', name: 'GL-21 Grenade Launcher', code: 'DLULD' },
  { id: 'gl-52-de-escalator', name: 'GL-52 De-Escalator', code: 'DRULR' },
  { id: 'tx-41-sterilizer', name: 'TX-41 Sterilizer', code: 'DLUDL' },
  { id: 'flam-40-flamethrower', name: 'FLAM-40 Flamethrower', code: 'DLUDU' },
  { id: 'las-98-laser-cannon', name: 'LAS-98 Laser Cannon', code: 'DLDUL' },
  { id: 'las-99-quasar-cannon', name: 'LAS-99 Quasar Cannon', code: 'DDULR' },
  { id: 'arc-3-arc-thrower', name: 'ARC-3 Arc Thrower', code: 'DRDULL' },
  { id: 'mls-4x-commando', name: 'MLS-4X Commando', code: 'DLUDR' },
  { id: 'eat-17-expendable-anti-tank', name: 'EAT-17 Expendable Anti-tank', code: 'DDLUR' },
  { id: 'ac-8-autocannon', name: 'AC-8 Autocannon', code: 'DLDUUR' },
  { id: 'rl-77-airburst-rocket-launcher', name: 'RL-77 Airburst Rocket Launcher', code: 'DUULR' },
  { id: 'faf-14-spear-launcher', name: 'FAF-14 Spear Launcher', code: 'DDUDD' },
  { id: 'sta-x3-w-a-s-p-launcher', name: 'StA-X3 W.A.S.P. Launcher', code: 'DDUDR' },
  { id: 'gr-8-recoilless-rifle', name: 'GR-8 Recoilless Rifle', code: 'DLRRL' },
  { id: 'b-1-supply-pack', name: 'B-1 Supply Pack', code: 'DLDUUD' },
  { id: 'b-100-portable-hellbomb', name: 'B-100 Portable Hellbomb', code: 'DRUUU' },
  { id: 'lift-860-hover-pack', name: 'LIFT-860 Hover Pack', code: 'DUUDLR' },
  { id: 'lift-850-jump-pack', name: 'LIFT-850 Jump Pack', code: 'DUUDU' },
  { id: 'sh-32-shield-generator-pack', name: 'SH-32 Shield Generator Pack', code: 'DULRLR' },
  { id: 'sh-51-directional-shield-backpack', name: 'SH-51 Directional Shield Backpack', code: 'DULRUU' },
  { id: 'sh-20-ballistic-shield-backpack', name: 'SH-20 Ballistic Shield Backpack', code: 'DLDDUL' },
  { id: 'ax-arc-3-guard-dog-k-9', name: 'AX/ARC-3 "Guard Dog" K-9', code: 'DULURL' },
  { id: 'ax-ar-23-guard-dog', name: 'AX/AR-23 "Guard Dog"', code: 'DULURD' },
  { id: 'ax-las-5-guard-dog-rover', name: 'AX/LAS-5 "Guard Dog" Rover', code: 'DULURR' },
  { id: 'ax-tx-13-guard-dog-dog-breath', name: 'AX/TX-13 "Guard Dog" Dog Breath', code: 'DULURU' },
  { id: 'm-103-supply-frv', name: 'M-103 Supply FRV', code: 'LDLLDUR' },
  { id: 'm-104-incinerator-frv', name: 'M-104 Incinerator FRV', code: 'LDRLDUU' },
  { id: 'exo-49-emancipator-exosuit', name: 'EXO-49 Emancipator Exosuit', code: 'LDRULDU' },
  { id: 'exo-45-patriot-exosuit', name: 'EXO-45 Patriot Exosuit', code: 'LDRULDD' },
  { id: 'm-102-gunner-frv', name: 'M-102 Gunner FRV', code: 'LDRDRDU' },
  { id: 'td-220-bastion-mk-xvi', name: 'TD-220 Bastion MK XVI', code: 'LDRDLDUDU' },
  { id: 'exo-55-breakthrough-exosuit', name: 'EXO-55 Breakthrough Exosuit', code: 'LDRLRDU' },
  { id: 'exo-51-lumberer-exosuit', name: 'EXO-51 Lumberer Exosuit', code: 'LDRURLU' },
  { id: 'a-g-16-gatling-sentry', name: 'A/G-16 Gatling Sentry', code: 'DURL' },
  { id: 'a-mg-43-machine-gun-sentry', name: 'A/MG-43 Machine Gun Sentry', code: 'DURRU' },
  { id: 'e-flam-40-flame-sentry', name: 'E/FLAM-40 Flame Sentry', code: 'DURDUU' },
  { id: 'a-mls-4x-rocket-sentry', name: 'A/MLS-4X Rocket Sentry', code: 'DURRL' },
  { id: 'a-ac-8-autocannon-sentry', name: 'A/AC-8 Autocannon Sentry', code: 'DURULU' },
  { id: 'a-m-23-ems-mortar-sentry', name: 'A/M-23 EMS Mortar Sentry', code: 'DURDR' },
  { id: 'a-m-12-mortar-sentry', name: 'A/M-12 Mortar Sentry', code: 'DURRD' },
  { id: 'fx-12-shield-generator-relay', name: 'FX-12 Shield Generator Relay', code: 'DDLRLR' },
  { id: 'e-gl-21-grenadier-battlement', name: 'E/GL-21 Grenadier Battlement', code: 'DRDLR' },
  { id: 'e-at-12-anti-tank-emplacement', name: 'E/AT-12 Anti-Tank Emplacement', code: 'DULRRR' },
  { id: 'e-mg-101-hmg-emplacement', name: 'E/MG-101 HMG Emplacement', code: 'DULRRL' },
  { id: 'a-arc-3-tesla-tower', name: 'A/ARC-3 Tesla Tower', code: 'DURULR' },
  { id: 'md-17-anti-tank-mines', name: 'MD-17 Anti-Tank Mines', code: 'DLUU' },
  { id: 'md-8-gas-mines', name: 'MD-8 Gas Mines', code: 'DLLR' },
  { id: 'md-6-anti-personnel-minefield', name: 'MD-6 Anti-Personnel Minefield', code: 'DLUR' },
  { id: 'md-i4-incendiary-mines', name: 'MD-I4 Incendiary Mines', code: 'DLLD' },
  { id: 'reinforce', name: 'Reinforce', code: 'UDRLU' },
  { id: 'sos-beacon', name: 'SOS Beacon', code: 'UDRU' },
  { id: 'resupply', name: 'Resupply', code: 'DDUR' },
  { id: 'nux-223-hellbomb', name: 'NUX-223 Hellbomb', code: 'DULDURDU' },
  { id: 'sssd-delivery', name: 'SSSD Delivery', code: 'DDDUU' },
  { id: 'seismic-probe', name: 'Seismic Probe', code: 'UULRDD' },
  { id: 'upload-data', name: 'Upload Data', code: 'LRUUU' },
  { id: 'eagle-rearm', name: 'Eagle Rearm', code: 'UULUR' },
  { id: 'seaf-artillery', name: 'SEAF Artillery', code: 'RUUD' },
  { id: 'super-earth-flag', name: 'Super Earth Flag', code: 'DUDU' },
  { id: 'hive-breaker-drill', name: 'Hive Breaker Drill', code: 'LUDRDD' },
  { id: 'mgx-42-bullet-storm', name: 'MGX-42 Bullet Storm', code: 'DLDRUL' },
  { id: 's-11-speargun', name: 'S-11 Speargun', code: 'DRDLUR' },
  { id: 'cqc-9-defoliation-tool', name: 'CQC-9 Defoliation Tool', code: 'DLRRD' },
  { id: 'cqc-20-breaching-hammer', name: 'CQC-20 Breaching Hammer', code: 'DLRLU' },
  { id: 'plas-45-epoch', name: 'PLAS-45 Epoch', code: 'DLULR' },
  { id: 'eat-700-expendable-napalm', name: 'EAT-700 Expendable Napalm', code: 'DDLUL' },
  { id: 'eat-411-leveller', name: 'EAT-411 Leveller', code: 'DDLUD' },
  { id: 'gl-28-belt-fed-grenade-launcher', name: 'GL-28 Belt-Fed Grenade Launcher', code: 'DLULUU' },
  { id: 'b-md-c4-pack', name: 'B/MD C4 Pack', code: 'DRUURU' },
  { id: 'ms-11-solo-silo', name: 'MS-11 Solo Silo', code: 'DURDD' },
  { id: 'b-flam-80-cremator', name: 'B/FLAM-80 Cremator', code: 'DDRDUU' },
  { id: 'm-1000-maxigun', name: 'M-1000 Maxigun', code: 'DLRDUU' },
  { id: 'meltagun', name: '40-K Meltagun', code: 'DLULLD' },
];

const DEFAULT_HELLDIVERS_OPTIONS: HelldiversPresetOptions = {
  stratagemId: helldivers2StratagemPresets[0]?.id ?? '',
  movementKeys: 'arrows',
  modifierKey: 'Ctrl',
  modifierBehavior: 'hold',
  keyDelayMs: 45,
  modifierLeadInMs: 55,
};

const HELLDIVERS_DEFAULTS_STORAGE_KEY = 'winutils.macros.helldiversDefaults';

function sanitizeHelldiversOptions(input: Partial<HelldiversPresetOptions> | null | undefined): HelldiversPresetOptions {
  const firstStratagemId = helldivers2StratagemPresets[0]?.id ?? '';
  const stratagemId = typeof input?.stratagemId === 'string' && helldivers2StratagemPresets.some(item => item.id === input.stratagemId)
    ? input.stratagemId
    : firstStratagemId;
  const movementKeys: HelldiversMovementKeys = input?.movementKeys === 'wasd' ? 'wasd' : 'arrows';
  const modifierKey: HelldiversModifierKey = input?.modifierKey === 'Alt' || input?.modifierKey === 'Shift' || input?.modifierKey === 'none' ? input.modifierKey : 'Ctrl';
  const modifierBehavior: HelldiversModifierBehavior = input?.modifierBehavior === 'press' ? 'press' : 'hold';

  return {
    stratagemId,
    movementKeys,
    modifierKey,
    modifierBehavior,
    keyDelayMs: clampInteger(Number(input?.keyDelayMs), 0, 2000, DEFAULT_HELLDIVERS_OPTIONS.keyDelayMs),
    modifierLeadInMs: clampInteger(Number(input?.modifierLeadInMs), 0, 2000, DEFAULT_HELLDIVERS_OPTIONS.modifierLeadInMs),
  };
}

function loadStoredHelldiversDefaults(): HelldiversPresetOptions {
  if (typeof window === 'undefined') return DEFAULT_HELLDIVERS_OPTIONS;

  const raw = window.localStorage.getItem(HELLDIVERS_DEFAULTS_STORAGE_KEY);
  if (!raw) return DEFAULT_HELLDIVERS_OPTIONS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('Failed to parse stored Helldivers defaults.', error);
    return DEFAULT_HELLDIVERS_OPTIONS;
  }

  if (!parsed || typeof parsed !== 'object') return DEFAULT_HELLDIVERS_OPTIONS;
  return sanitizeHelldiversOptions(parsed as Partial<HelldiversPresetOptions>);
}

function persistHelldiversDefaults(options: HelldiversPresetOptions): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HELLDIVERS_DEFAULTS_STORAGE_KEY, JSON.stringify(options));
}

const helldiversDirectionDisplay: Record<HelldiversDirection, string> = {
  U: '↑',
  D: '↓',
  L: '←',
  R: '→',
};

function helldiversDirectionToKey(direction: HelldiversDirection, movementKeys: HelldiversMovementKeys): string {
  if (movementKeys === 'wasd') {
    if (direction === 'U') return 'W';
    if (direction === 'D') return 'S';
    if (direction === 'L') return 'A';
    return 'D';
  }

  if (direction === 'U') return 'Up';
  if (direction === 'D') return 'Down';
  if (direction === 'L') return 'Left';
  return 'Right';
}

function formatHelldiversCode(code: string): string {
  return code
    .split('')
    .map(direction => helldiversDirectionDisplay[helldiversTokenToDirection(direction)] ?? direction.toUpperCase())
    .join(' ');
}

function helldiversTokenToDirection(token: string): HelldiversDirection {
  const normalized = token.trim().toUpperCase();
  if (normalized === 'W' || normalized === 'U' || normalized === '↑') return 'U';
  if (normalized === 'S' || normalized === 'D' || normalized === '↓') return 'D';
  if (normalized === 'A' || normalized === 'L' || normalized === '←') return 'L';
  return 'R';
}

function createHelldiversActions(
  stratagem: HelldiversStratagemPreset,
  options: HelldiversPresetOptions,
): MacroAction[] {
  const actions: MacroAction[] = [];
  const keyDelayMs = clampInteger(options.keyDelayMs, 0, 2000, DEFAULT_HELLDIVERS_OPTIONS.keyDelayMs);
  const modifierLeadInMs = clampInteger(options.modifierLeadInMs, 0, 2000, DEFAULT_HELLDIVERS_OPTIONS.modifierLeadInMs);
  const directions = stratagem.code.split('').map(helldiversTokenToDirection);

  if (options.modifierKey !== 'none') {
    if (options.modifierBehavior === 'hold') {
      actions.push({ id: newId(), type: 'keyboard', enabled: true, key: options.modifierKey, pressType: 'down' });
    } else {
      actions.push({ id: newId(), type: 'keyboard', enabled: true, key: options.modifierKey, pressType: 'press' });
    }

    if (modifierLeadInMs > 0) {
      actions.push({ id: newId(), type: 'delay', enabled: true, milliseconds: modifierLeadInMs });
    }
  }

  directions.forEach((direction, index) => {
    actions.push({
      id: newId(),
      type: 'keyboard',
      enabled: true,
      key: helldiversDirectionToKey(direction, options.movementKeys),
      pressType: 'press',
    });

    if (keyDelayMs > 0 && index < directions.length - 1) {
      actions.push({ id: newId(), type: 'delay', enabled: true, milliseconds: keyDelayMs });
    }
  });

  if (options.modifierKey !== 'none' && options.modifierBehavior === 'hold') {
    actions.push({ id: newId(), type: 'keyboard', enabled: true, key: options.modifierKey, pressType: 'up' });
  }

  return actions;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  const integer = Math.trunc(Number(value));
  if (!Number.isFinite(integer)) return fallback;
  return Math.max(min, Math.min(max, integer));
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

type ActionPairRole = 'start' | 'middle' | 'end';

interface ActionPairDecoration {
  pairIndex: number;
  role: ActionPairRole;
  label: string;
}

const actionPairColors = ['#8dd2ff', '#f8c36a', '#7bd88f', '#ff8aa1', '#c59cff'];

function normalizedActionKey(key: string): string {
  return key.trim().toLowerCase();
}

function actionPairRole(action: MacroAction): 'down' | 'up' | null {
  if (action.type === 'keyboard') {
    if (action.pressType === 'down') return 'down';
    if (action.pressType === 'up') return 'up';
  }

  if (action.type === 'mouse') {
    if (action.actionType === 'down') return 'down';
    if (action.actionType === 'up') return 'up';
  }

  return null;
}

function actionPairKey(action: MacroAction): string | null {
  if (action.type === 'keyboard' && actionPairRole(action)) {
    return `keyboard:${normalizedActionKey(action.key)}`;
  }

  if (action.type === 'mouse' && actionPairRole(action)) {
    return `mouse:${action.button}`;
  }

  return null;
}

function actionPairLabel(action: MacroAction): string {
  if (action.type === 'keyboard') return `Linked ${action.key}`;
  if (action.type === 'mouse') return `Linked ${action.button} button`;
  return 'Linked down/up pair';
}

function buildActionPairDecorations(actions: MacroAction[]): Map<string, ActionPairDecoration> {
  const decorations = new Map<string, ActionPairDecoration>();
  const stacks = new Map<string, number[]>();
  let pairIndex = 0;

  actions.forEach((action, index) => {
    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) return;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(index);
      stacks.set(key, stack);
      return;
    }

    const stack = stacks.get(key);
    const startIndex = stack?.pop();
    if (startIndex === undefined) return;

    const currentPairIndex = pairIndex++;
    const label = actionPairLabel(actions[startIndex]);
    for (let actionIndex = startIndex; actionIndex <= index; actionIndex++) {
      const linkedAction = actions[actionIndex];
      if (decorations.has(linkedAction.id)) continue;
      decorations.set(linkedAction.id, {
        pairIndex: currentPairIndex,
        role: actionIndex === startIndex ? 'start' : actionIndex === index ? 'end' : 'middle',
        label,
      });
    }
  });

  return decorations;
}

function actionPairStyle(decoration: ActionPairDecoration | undefined): CSSProperties | undefined {
  if (!decoration) return undefined;
  const offsetSteps = [0, 5, -5, 10, -10];
  return {
    '--action-link-color': actionPairColors[decoration.pairIndex % actionPairColors.length],
    '--action-link-offset': `${offsetSteps[decoration.pairIndex % offsetSteps.length]}px`,
  } as CSSProperties;
}

function countDelayActions(actions: MacroAction[]): number {
  return actions.reduce((count, action) => {
    if (action.type === 'delay') return count + 1;
    if (action.type === 'repeat') return count + countDelayActions(action.actions);
    if (action.type === 'if') return count + countDelayActions(action.thenActions) + countDelayActions(action.elseActions);
    return count;
  }, 0);
}

function countDelayExecutions(actions: MacroAction[], multiplier = 1): number {
  return actions.reduce((count, action) => {
    if (action.type === 'delay') return count + multiplier;
    if (action.type === 'repeat') return count + countDelayExecutions(action.actions, multiplier * clampInteger(action.times, 0, 10_000, 0));
    if (action.type === 'if') return count + countDelayExecutions(action.thenActions, multiplier) + countDelayExecutions(action.elseActions, multiplier);
    return count;
  }, 0);
}

function fitDelayActionsToRunTime(actions: MacroAction[], totalMs: number): MacroAction[] {
  const delayExecutions = countDelayExecutions(actions);
  if (delayExecutions === 0) return actions;

  const total = clampInteger(totalMs, 0, 24 * 60 * 60 * 1000, 0);
  const baseDelay = Math.floor(total / delayExecutions);
  let remainder = total % delayExecutions;

  const apply = (items: MacroAction[], multiplier = 1): MacroAction[] => items.map(action => {
    if (action.type === 'delay') {
      const milliseconds = baseDelay + (remainder >= multiplier ? 1 : 0);
      if (remainder >= multiplier) remainder -= multiplier;
      return { ...action, milliseconds };
    }

    if (action.type === 'repeat') return { ...action, actions: apply(action.actions, multiplier * clampInteger(action.times, 0, 10_000, 0)) };
    if (action.type === 'if') return { ...action, thenActions: apply(action.thenActions, multiplier), elseActions: apply(action.elseActions, multiplier) };
    return action;
  });

  return apply(actions);
}

function hasActionPair(actions: MacroAction[]): boolean {
  const stacks = new Map<string, number[]>();

  for (const action of actions) {
    if (action.type === 'repeat' && hasActionPair(action.actions)) return true;
    if (action.type === 'if' && (hasActionPair(action.thenActions) || hasActionPair(action.elseActions))) return true;

    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) continue;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(1);
      stacks.set(key, stack);
      continue;
    }

    const stack = stacks.get(key);
    if (stack?.length) return true;
  }

  return false;
}

function toPressAction(action: MacroAction): MacroAction {
  if (action.type === 'keyboard') return { ...action, pressType: 'press' };
  if (action.type === 'mouse') return { ...action, actionType: 'click' };
  return action;
}

function convertFlatActionPairsToPress(actions: MacroAction[]): MacroAction[] {
  const stacks = new Map<string, number[]>();
  const replacements = new Map<string, MacroAction>();
  const removeIds = new Set<string>();

  actions.forEach((action, index) => {
    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) return;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(index);
      stacks.set(key, stack);
      return;
    }

    const stack = stacks.get(key);
    const startIndex = stack?.pop();
    if (startIndex === undefined) return;

    const startAction = actions[startIndex];
    replacements.set(startAction.id, toPressAction(startAction));
    removeIds.add(action.id);

    const between = actions.slice(startIndex + 1, index);
    if (between.length > 0 && between.every(item => item.type === 'delay')) {
      between.forEach(item => removeIds.add(item.id));
    }
  });

  return actions
    .filter(action => !removeIds.has(action.id))
    .map(action => replacements.get(action.id) ?? action);
}

function convertActionPairsToPress(actions: MacroAction[]): MacroAction[] {
  const convertedNested = actions.map(action => {
    if (action.type === 'repeat') return { ...action, actions: convertActionPairsToPress(action.actions) };
    if (action.type === 'if') {
      return {
        ...action,
        thenActions: convertActionPairsToPress(action.thenActions),
        elseActions: convertActionPairsToPress(action.elseActions),
      };
    }
    return action;
  });

  return convertFlatActionPairsToPress(convertedNested);
}

function autoClickerDelayMs(options: AutoClickerPresetOptions): number {
  if (options.timingMode === 'delay') {
    return clampInteger(options.delayMs, 0, 60_000, DEFAULT_AUTO_CLICKER_OPTIONS.delayMs);
  }

  const clicksPerSecond = clampFloat(options.clicksPerSecond, 0.1, 10_000, DEFAULT_AUTO_CLICKER_OPTIONS.clicksPerSecond);
  const targetPeriodMs = 1000 / clicksPerSecond;
  return Math.max(0, Math.floor(targetPeriodMs - AUTO_CLICKER_CLICK_MS));
}

const macroPresets: MacroPreset[] = [
  {
    id: 'auto-clicker',
    label: 'Auto Clicker',
    description: 'Left-click repeatedly with a configurable pause between clicks.',
    createActions: ({ autoClicker }) => [{
      id: newId(),
      type: 'repeat',
      enabled: true,
      times: clampInteger(autoClicker.repeatCount, 1, 10_000, DEFAULT_AUTO_CLICKER_OPTIONS.repeatCount),
      actions: [
        { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'click' },
        { id: newId(), type: 'delay', enabled: true, milliseconds: autoClickerDelayMs(autoClicker) },
      ],
    }],
  },
  {
    id: 'key-spammer',
    label: 'Key Spammer',
    description: 'Press Space repeatedly with a short pause between presses.',
    createActions: () => [{
      id: newId(),
      type: 'repeat',
      enabled: true,
      times: 25,
      actions: [
        { id: newId(), type: 'keyboard', enabled: true, key: 'Space', pressType: 'press' },
        { id: newId(), type: 'delay', enabled: true, milliseconds: 120 },
      ],
    }],
  },
  {
    id: 'hold-left-click',
    label: 'Hold Left Click',
    description: 'Hold left mouse down for one second, then release it.',
    createActions: () => [
      { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'down' },
      { id: newId(), type: 'delay', enabled: true, milliseconds: 1000 },
      { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'up' },
    ],
  },
  {
    id: 'window-title-if',
    label: 'Window Title If',
    description: 'Run different actions depending on the focused window title.',
    createActions: () => [{
      id: newId(),
      type: 'if',
      enabled: true,
      condition: { source: 'active-window-title', operator: 'contains', value: '', caseSensitive: false },
      thenActions: [{ id: newId(), type: 'text', enabled: true, text: 'Matched window' }],
      elseActions: [{ id: newId(), type: 'text', enabled: true, text: 'Other window' }],
    }],
  },
  {
    id: 'helldivers-2-stratagem',
    label: 'Helldivers 2 Stratagem',
    description: 'Insert a Helldivers 2 stratagem input sequence with configurable modifier behavior.',
    createActions: ({ helldivers }) => {
      const stratagem = helldivers2StratagemPresets.find(item => item.id === helldivers.stratagemId) ?? helldivers2StratagemPresets[0];
      return stratagem ? createHelldiversActions(stratagem, helldivers) : [];
    },
  },
];

// ─── Hotkey capture input ─────────────────────────────────────────────────

function HotkeyInput({
  value,
  onChange,
  placeholder = 'Click and press keys…',
  title = 'Click here, then press the key combination that should trigger this macro globally.',
  allowModifierKeys = false,
  allowNonAsciiKeys = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
  allowModifierKeys?: boolean;
  allowNonAsciiKeys?: boolean;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  const [pendingModifierHotkey, setPendingModifierHotkey] = useState<string | null>(null);

  const finishCapture = (nextValue: string) => {
    onChange(nextValue);
    setPendingModifierHotkey(null);
    setCapturing(false);
  };

  const modifierPartsForEvent = (event: React.KeyboardEvent<HTMLInputElement>, capturedKey: string): string[] => {
    const parts: string[] = [];
    if (event.ctrlKey || capturedKey === 'Ctrl') parts.push('Ctrl');
    if (event.altKey || capturedKey === 'Alt') parts.push('Alt');
    if (event.shiftKey || capturedKey === 'Shift') parts.push('Shift');
    if (event.metaKey || capturedKey === 'Win') parts.push('Win');
    return parts;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const rawCapturedKey = captureKeyName(e);
    const capturedKey = !allowNonAsciiKeys && !isCapturedModifierKey(rawCapturedKey) && !isElectronHotkeyKey(rawCapturedKey)
      ? capturePhysicalKeyName(e.code) ?? rawCapturedKey
      : rawCapturedKey;
    if (isCapturedModifierKey(capturedKey) && !allowModifierKeys) return;
    if (!allowNonAsciiKeys && !isCapturedModifierKey(capturedKey) && !isElectronHotkeyKey(capturedKey)) return;

    if (isCapturedModifierKey(capturedKey)) {
      setPendingModifierHotkey(modifierPartsForEvent(e, capturedKey).join('+'));
      return;
    }

    const parts = modifierPartsForEvent(e, capturedKey);
    parts.push(capturedKey);
    finishCapture(parts.join('+'));
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (pendingModifierHotkey && isCapturedModifierKey(captureKeyName(e))) {
      finishCapture(pendingModifierHotkey);
    }
  };

  return (
    <input
      className={`macro-input${capturing ? ' macro-input--capturing' : ''}`}
      value={capturing ? pendingModifierHotkey ?? '' : value}
      placeholder={capturing ? 'Press keys…' : placeholder}
      readOnly={!capturing}
      onFocus={() => {
        setPendingModifierHotkey(null);
        setCapturing(true);
      }}
      onBlur={() => {
        setPendingModifierHotkey(null);
        setCapturing(false);
      }}
      onKeyDown={capturing ? handleKeyDown : undefined}
      onKeyUp={capturing ? handleKeyUp : undefined}
      onChange={() => {}}
      title={title}
    />
  );
}

function isElectronHotkeyKey(key: string): boolean {
  return /^[A-Z0-9]$/.test(key)
    || /^(F\d{1,2}|Num\d|NumDec|NumAdd|NumSub|NumMult|NumDiv|Enter|Space|Escape|Esc|Tab|Backspace|Delete|Del|Insert|Left|Right|Up|Down|Home|End|PageUp|PageDown|PgUp|PgDn|NumLock|Semicolon|Equal|Comma|Minus|Period|Slash|Backquote|BracketLeft|Backslash|BracketRight|Quote)$/i.test(key);
}

function conditionOperatorsForSource(source: MacroConditionSource): MacroConditionOperator[] {
  if (source === 'file-exists') return fileConditionOperators;
  if (source === 'key-state') return keyConditionOperators;
  return textConditionOperators;
}

function normalizeConditionForSource(condition: MacroCondition, source: MacroConditionSource): MacroCondition {
  const operators = conditionOperatorsForSource(source);
  return {
    ...condition,
    source,
    operator: operators.includes(condition.operator) ? condition.operator : operators[0],
  };
}

// ─── Action editor ────────────────────────────────────────────────────────

function ActionEditor({
  action,
  onChange,
  onDelete,
  pairDecoration,
  dragController,
}: {
  action: MacroAction;
  onChange: (a: MacroAction, insertAfter?: MacroAction[]) => void;
  onDelete: () => void;
  pairDecoration?: ActionPairDecoration;
  dragController: ActionDragController;
}): ReactElement {
  const patch = (updates: Partial<MacroAction>, insertAfter?: MacroAction[]) =>
    onChange({ ...action, ...updates } as MacroAction, insertAfter);

  const patchCondition = (updates: Partial<MacroCondition>) => {
    if (action.type !== 'if') return;
    const current = (action as IfAction).condition;
    patch({ condition: { ...current, ...updates } } as Partial<MacroAction>);
  };

  const changeKeyboardPressType = (pressType: KeyboardAction['pressType']) => {
    if (action.type !== 'keyboard') return;
    const insertAfter = pressType === 'down' && action.pressType !== 'down'
      ? keyboardHoldReleaseActions(action.key)
      : undefined;
    patch({ pressType } as Partial<MacroAction>, insertAfter);
  };

  const anchorDecoration = pairDecoration?.role === 'middle' ? undefined : pairDecoration;
  const pairClass = anchorDecoration ? ` action-row--linked action-row--linked-${anchorDecoration.role}` : '';

  return (
    <div className={`action-row${action.enabled ? '' : ' action-row--disabled'}${pairClass}`} style={actionPairStyle(anchorDecoration)} title={anchorDecoration?.label}>
      <div className="action-row-header">
        <span className="action-type-badge" title={macroActionDescriptions[action.type]}>{action.type}</span>
        <div className="action-row-controls">
          <button
            type="button"
            className="micro-button"
            onClick={() => patch({ enabled: !action.enabled })}
            title={action.enabled ? 'Disable this action without deleting it.' : 'Enable this action again.'}
          >
            {action.enabled ? '⏸' : '▶'}
          </button>
          <button type="button" className="micro-button micro-button--danger" onClick={onDelete} title="Delete this action from the macro.">
            ✕
          </button>
        </div>
      </div>

      {action.type === 'delay' && (
        <div className="action-fields">
          <label className="macro-label">Delay (ms)</label>
          <input
            type="number"
            className="macro-input"
            value={(action as DelayAction).milliseconds}
            min={0}
            onChange={e => patch({ milliseconds: Number(e.target.value) })}
            title="How long to pause before continuing to the next action."
          />
        </div>
      )}

      {action.type === 'keyboard' && (
        <div className="action-fields">
          <label className="macro-label">Key</label>
          <HotkeyInput
            value={(action as KeyboardAction).key}
            placeholder="Click and press key…"
            onChange={key => patch({ key } as Partial<MacroAction>)}
            title="Click here, then press the key or key combination this action should send."
            allowModifierKeys
          />
          <label className="macro-label">Type</label>
          <select
            className="macro-select"
            value={(action as KeyboardAction).pressType}
            onChange={e => changeKeyboardPressType(e.target.value as KeyboardAction['pressType'])}
            title="Choose whether to press and release the key, hold it down, or release it."
          >
            <option value="press">Press (down+up)</option>
            <option value="down">Key Down</option>
            <option value="up">Key Up</option>
          </select>
        </div>
      )}

      {action.type === 'mouse' && (
        <div className="action-fields">
          <label className="macro-label">Button</label>
          <select
            className="macro-select"
            value={(action as MouseAction).button}
            onChange={e => patch({ button: e.target.value as MouseAction['button'] })}
            title="Mouse button used by this action."
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="middle">Middle</option>
          </select>
          <label className="macro-label">Action</label>
          <select
            className="macro-select"
            value={(action as MouseAction).actionType}
            onChange={e => patch({ actionType: e.target.value as MouseAction['actionType'] })}
            title="Mouse operation to run. Down and Up are useful for drag-style macros."
          >
            <option value="click">Click</option>
            <option value="double-click">Double Click</option>
            <option value="down">Down</option>
            <option value="up">Up</option>
            <option value="move">Move to position</option>
          </select>
          {(action as MouseAction).actionType === 'move' && (
            <>
              <label className="macro-label">X</label>
              <input
                type="number"
                className="macro-input macro-input--half"
                value={(action as MouseAction).x ?? ''}
                onChange={e => patch({ x: Number(e.target.value) })}
                title="Screen X coordinate for mouse movement."
              />
              <label className="macro-label">Y</label>
              <input
                type="number"
                className="macro-input macro-input--half"
                value={(action as MouseAction).y ?? ''}
                onChange={e => patch({ y: Number(e.target.value) })}
                title="Screen Y coordinate for mouse movement."
              />
            </>
          )}
        </div>
      )}

      {action.type === 'launch' && (
        <div className="action-fields">
          <label className="macro-label">Path</label>
          <input
            className="macro-input"
            value={(action as LaunchAction).path}
            placeholder="C:\path\to\app.exe"
            onChange={e => patch({ path: e.target.value })}
            title="Full path to the app or executable to launch."
          />
          <label className="macro-label">Arguments</label>
          <input
            className="macro-input"
            value={(action as LaunchAction).arguments}
            placeholder="Optional arguments"
            onChange={e => patch({ arguments: e.target.value })}
            title="Optional command-line arguments passed to the launched app."
          />
        </div>
      )}

      {action.type === 'command' && (
        <div className="action-fields">
          <label className="macro-label">PowerShell command</label>
          <textarea
            className="macro-textarea"
            value={(action as CommandAction).command}
            onChange={e => patch({ command: e.target.value })}
            rows={3}
            title="PowerShell command to run when this action executes."
          />
          <label className="macro-label">Working directory</label>
          <input
            className="macro-input"
            value={(action as CommandAction).workingDirectory}
            placeholder="Optional"
            onChange={e => patch({ workingDirectory: e.target.value })}
            title="Optional folder where the PowerShell command should run."
          />
        </div>
      )}

      {action.type === 'text' && (
        <div className="action-fields">
          <label className="macro-label">Text to type</label>
          <textarea
            className="macro-textarea"
            value={(action as TextAction).text}
            onChange={e => patch({ text: e.target.value })}
            rows={3}
            title="Text that will be typed into the currently focused window."
          />
        </div>
      )}

      {action.type === 'repeat' && (
        <div className="action-nested-editor">
          <div className="action-fields">
            <label className="macro-label">Times</label>
            <input
              type="number"
              className="macro-input macro-input--half"
              value={(action as RepeatAction).times}
              min={0}
              max={10000}
              onChange={e => patch({ times: Number(e.target.value) } as Partial<MacroAction>)}
              title="How many times to run the nested actions."
            />
          </div>
          <NestedActionsEditor
            label="Repeated actions"
            emptyText="No repeated actions yet."
            listId={nestedActionListId(action.id, 'actions')}
            actions={(action as RepeatAction).actions}
            onChange={actions => patch({ actions } as Partial<MacroAction>)}
            dragController={dragController}
          />
        </div>
      )}

      {action.type === 'if' && (
        <div className="action-nested-editor">
          <div className="macro-condition-grid">
            <label className="macro-label">If</label>
            <select
              className="macro-select"
              value={(action as IfAction).condition.source}
              onChange={e => {
                const source = e.target.value as MacroConditionSource;
                patch({ condition: normalizeConditionForSource((action as IfAction).condition, source) } as Partial<MacroAction>);
              }}
              title="Choose what this condition should inspect."
            >
              {(Object.keys(conditionSourceLabels) as MacroConditionSource[]).map(source => (
                <option key={source} value={source}>{conditionSourceLabels[source]}</option>
              ))}
            </select>

            <label className="macro-label">Operator</label>
            <select
              className="macro-select"
              value={(action as IfAction).condition.operator}
              onChange={e => patchCondition({ operator: e.target.value as MacroConditionOperator })}
              title="Choose how the condition should compare the inspected value."
            >
              {conditionOperatorsForSource((action as IfAction).condition.source).map(operator => (
                <option key={operator} value={operator}>{conditionOperatorLabels[operator]}</option>
              ))}
            </select>

            <label className="macro-label">Value</label>
            {(action as IfAction).condition.source === 'key-state' ? (
              <HotkeyInput
                value={(action as IfAction).condition.value}
                placeholder="Click and press key…"
                onChange={value => patchCondition({ value })}
                title="Click here, then press the key or key combination this IF condition should check."
                allowModifierKeys
              />
            ) : (
              <input
                className="macro-input"
                value={(action as IfAction).condition.value}
                placeholder={(action as IfAction).condition.source === 'file-exists' ? 'C:\\path\\to\\file.txt' : 'Text or regex'}
                onChange={e => patchCondition({ value: e.target.value })}
                title={(action as IfAction).condition.source === 'file-exists' ? 'Path to check for existence.' : 'Text or regular expression to compare against.'}
              />
            )}

            {(action as IfAction).condition.source !== 'file-exists' && (action as IfAction).condition.source !== 'key-state' ? (
              <label className="macro-check-label" title="Make this text comparison case-sensitive.">
                <input
                  type="checkbox"
                  checked={(action as IfAction).condition.caseSensitive}
                  onChange={e => patchCondition({ caseSensitive: e.target.checked })}
                />
                <span>Case</span>
              </label>
            ) : null}
          </div>

          <NestedActionsEditor
            label="Then"
            emptyText="No Then actions yet."
            listId={nestedActionListId(action.id, 'then')}
            actions={(action as IfAction).thenActions}
            onChange={thenActions => patch({ thenActions } as Partial<MacroAction>)}
            dragController={dragController}
          />
          <NestedActionsEditor
            label="Else"
            emptyText="No Else actions yet."
            listId={nestedActionListId(action.id, 'else')}
            actions={(action as IfAction).elseActions}
            onChange={elseActions => patch({ elseActions } as Partial<MacroAction>)}
            dragController={dragController}
          />
        </div>
      )}
    </div>
  );
}

function NestedActionsEditor({
  label,
  emptyText,
  listId,
  actions,
  onChange,
  dragController,
}: {
  label: string;
  emptyText: string;
  listId: string;
  actions: MacroAction[];
  onChange: (actions: MacroAction[]) => void;
  dragController: ActionDragController;
}): ReactElement {
  const pairDecorations = buildActionPairDecorations(actions);
  const [hoveredPairIndex, setHoveredPairIndex] = useState<number | null>(null);
  const listDropActive = dragController.dropTarget?.listId === listId;

  const updateAction = (index: number, updated: MacroAction, insertAfter?: MacroAction[]) => {
    onChange(updateActionAt(actions, index, updated, insertAfter));
  };

  const deleteAction = (index: number) => {
    onChange(actions.filter((_, actionIndex) => actionIndex !== index));
  };

  return (
    <div className="nested-actions">
      <div className="nested-actions-header">
        <span>{label}</span>
        <div className="macro-add-actions">
          {actionTypes.map(type => (
            <button key={type} type="button" className="ghost-button ghost-button--xs" onClick={() => onChange([...actions, blankAction(type)])} title={macroActionDescriptions[type]}>
              +{type}
            </button>
          ))}
        </div>
      </div>
      <div className="nested-actions-list">
        {actions.length === 0 ? (
          <div
            className={`empty-state empty-state--compact nested-actions-empty-drop${listDropActive ? ' nested-actions-empty-drop--active' : ''}`}
            onDragOver={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.previewDrop({ listId, index: 0 });
            }}
            onDrop={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.dropAction({ listId, index: 0 });
            }}
          >{emptyText}</div>
        ) : null}
        {actions.map((nestedAction, index) => {
          const decoration = pairDecorations.get(nestedAction.id);
          return (
          <div
            key={nestedAction.id}
            className={`${actionDropClass('nested-action-row', listId, index, dragController.dropTarget)}${decoration ? ` nested-action-row--linked nested-action-row--linked-${decoration.role}${hoveredPairIndex === decoration.pairIndex ? ' nested-action-row--linked-hover' : ''}` : ''}`}
            style={actionPairStyle(decoration)}
            draggable
            onMouseEnter={() => setHoveredPairIndex(decoration?.pairIndex ?? null)}
            onMouseLeave={() => setHoveredPairIndex(null)}
            onDragStart={event => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', nestedAction.id);
              dragController.startDrag({ actionId: nestedAction.id, listId, index });
            }}
            onDragOver={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.previewDrop({ listId, index: dropIndexForEvent(event, index) });
            }}
            onDrop={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.dropAction({ listId, index: dropIndexForEvent(event, index) });
            }}
            onDragEnd={event => {
              event.stopPropagation();
              dragController.endDrag();
            }}
          >
            <span className="nested-action-index">{index + 1}</span>
            <ActionEditor
              action={nestedAction}
              onChange={(updated, insertAfter) => updateAction(index, updated, insertAfter)}
              onDelete={() => deleteAction(index)}
              pairDecoration={actionPairRole(nestedAction) ? decoration : undefined}
              dragController={dragController}
            />
          </div>
          );
        })}
        {actions.length > 0 ? (
          <div
            className={`nested-action-drop-end${listDropActive && dragController.dropTarget?.index === actions.length ? ' nested-action-drop-end--active' : ''}`}
            onDragOver={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.previewDrop({ listId, index: actions.length });
            }}
            onDrop={event => {
              event.preventDefault();
              event.stopPropagation();
              dragController.dropAction({ listId, index: actions.length });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

// ─── Main MacrosTab ───────────────────────────────────────────────────────

export function MacrosTab(): ReactElement {
  const [state, setState] = useState<MacroState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMacroId, setSelectedMacroId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [busyOp, setBusyOp] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileInput, setNewProfileInput] = useState('');
  const [activeApps, setActiveApps] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [runtime, setRuntime] = useState<MacroRuntimeStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboardPreviewEnabled, setKeyboardPreviewEnabled] = useState<boolean>(() => loadKeyboardPreviewEnabled());
  const [keyboardLayoutId, setKeyboardLayoutId] = useState<KeyboardPreviewLayoutId>(() => loadKeyboardPreviewLayout());
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runtimePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load state
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await window.winUtils.macros.getState();
      setState(s);
      setRuntime(s.runtime ?? null);
      setExpandedFolders(prev => {
        const next = new Set(prev);
        s.activeProfile.folders.forEach(f => { if (f.isExpanded) next.add(f.id); });
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load macros.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Push notification: main process auto-switched the active profile
  useEffect(() => {
    const off = window.winUtils.macros.onProfileChanged(s => {
      setState(s);
      setRuntime(s.runtime ?? null);
    });
    return off;
  }, []);

  const loadRuntime = useCallback(async () => {
    try {
      const stats = await window.winUtils.macros.getRuntimeStats();
      setRuntime(stats);
    } catch {
      // ignore transient runtime polling failures
    }
  }, []);

  useEffect(() => {
    void loadRuntime();
    runtimePollRef.current = setInterval(() => {
      void loadRuntime();
    }, 2500);
    return () => {
      if (runtimePollRef.current) clearInterval(runtimePollRef.current);
    };
  }, [loadRuntime]);

  const loadActiveApps = useCallback(async () => {
    setAppsLoading(true);
    try {
      const apps = await window.winUtils.macros.getActiveApps();
      setActiveApps(apps);
    } catch { /* ignore */ } finally {
      setAppsLoading(false);
    }
  }, []);

  useEffect(() => { void loadActiveApps(); }, [loadActiveApps]);

  useEffect(() => {
    appsPollRef.current = setInterval(() => {
      void window.winUtils.macros.getActiveApps().then(setActiveApps).catch(() => undefined);
    }, 3000);
    return () => {
      if (appsPollRef.current) clearInterval(appsPollRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(KEYBOARD_PREVIEW_ENABLED_STORAGE_KEY, keyboardPreviewEnabled ? '1' : '0');
  }, [keyboardPreviewEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(KEYBOARD_PREVIEW_LAYOUT_STORAGE_KEY, keyboardLayoutId);
  }, [keyboardLayoutId]);

  const api = window.winUtils.macros;

  const call = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusyOp(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
      return null;
    } finally {
      setBusyOp(false);
    }
  };

  const update = async (fn: () => Promise<MacroState>): Promise<void> => {
    const s = await call(fn);
    if (s) {
      setState(s);
      setRuntime(s.runtime ?? null);
    }
  };

  // Get selected macro
  const profile: MacroProfile | undefined = state?.activeProfile;
  const allMacros: Macro[] = profile
    ? [...profile.macros, ...profile.folders.flatMap((f: MacroFolder) => f.macros)]
    : [];
  const selectedMacro = allMacros.find(m => m.id === selectedMacroId) ?? null;
  const hotkeyConflicts = runtime?.hotkeyConflicts ?? state?.runtime?.hotkeyConflicts ?? [];

  const importHelldiversPack = async (options: HelldiversPresetOptions): Promise<void> => {
    let createdFirstMacroId: string | null = null;
    const folderBaseName = 'Helldivers 2 Stratagems';
    const existingFolderNames = new Set((profile?.folders ?? []).map(folder => folder.name.toLowerCase()));
    let folderName = folderBaseName;
    let suffix = 2;
    while (existingFolderNames.has(folderName.toLowerCase())) {
      folderName = `${folderBaseName} ${suffix}`;
      suffix += 1;
    }
    const folder = blankFolder(folderName);

    const nextState = await call(async () => {
      await api.upsertFolder(folder);
      for (const stratagem of helldivers2StratagemPresets) {
        const macro = blankMacro(stratagem.name);
        macro.actions = createHelldiversActions(stratagem, options);
        await api.upsertMacro(macro);
        await api.moveMacroToFolder(macro.id, folder.id);
        createdFirstMacroId ??= macro.id;
      }
      return api.getState();
    });

    if (!nextState) return;
    setState(nextState);
    setRuntime(nextState.runtime ?? null);
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.add(folder.id);
      return next;
    });
    if (createdFirstMacroId) {
      setSelectedMacroId(createdFirstMacroId);
    }
    setNotice(`Created ${helldivers2StratagemPresets.length} Helldivers stratagem macros in "${folderName}".`);
  };

  const applyHotkeySuggestion = async (suggestion: MacroHotkeySuggestion): Promise<void> => {
    const macro = allMacros.find(item => item.id === suggestion.macroId);
    if (!macro) {
      setError('Macro for this suggestion could not be found.');
      return;
    }
    await update(() => api.upsertMacro({ ...macro, hotkey: suggestion.suggestedHotkey }));
    setNotice(`Updated "${macro.name || '(unnamed)'}" to ${suggestion.suggestedHotkey}.`);
  };

  const exportActiveProfile = async (): Promise<void> => {
    const result = await call(() => api.exportProfile(state?.config.activeProfile));
    if (!result) return;
    if (!result.ok) {
      if (result.message && result.message !== 'Export cancelled.') {
        setError(result.message);
      }
      return;
    }
    setNotice(result.path ? `Profile exported to ${result.path}` : 'Profile exported.');
  };

  const importProfile = async (): Promise<void> => {
    await update(() => api.importProfile());
    setNotice('Profile imported successfully.');
  };

  // Save macro after debounced edit
  const saveMacro = useCallback((macro: Macro) => {
    const normalizedMacro: Macro = { ...macro, playback: normalizeMacroPlayback(macro.playback) };
    setState(prev => {
      if (!prev) return prev;
      const p = prev.activeProfile;
      const patchProfile = (prof: MacroProfile): MacroProfile => ({
        ...prof,
        macros: prof.macros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
        folders: prof.folders.map((f: MacroFolder) => ({
          ...f,
          macros: f.macros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
        })),
      });
      return {
        ...prev,
        activeProfile: patchProfile(p),
        allMacros: prev.allMacros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
      };
    });
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      void api.upsertMacro(normalizedMacro).then(s => {
        setState(s);
        setRuntime(s.runtime ?? null);
      }).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : 'Failed to save macro.');
        void refresh();
      });
    }, 600);
  }, [api]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) return <div className="empty-state">Loading macros…</div>;

  return (
    <div className="macros-layout">
      {/* ── Left panel: profile + macro tree ── */}
      <div className="macros-sidebar">

        {/* Profile bar */}
        <div className="macros-profile-bar">
          {addingProfile ? (
            <>
              <input
                className="macro-input"
                style={{ flex: 1 }}
                autoFocus
                placeholder="Profile name…"
                value={newProfileInput}
                onChange={e => setNewProfileInput(e.target.value)}
                title="Name for the new macro profile. Profiles can switch based on focused apps."
                onKeyDown={e => {
                  if (e.key === 'Enter' && newProfileInput.trim()) {
                    void update(() => api.addProfile(newProfileInput.trim())).then(() => {
                      setNewProfileInput(''); setAddingProfile(false);
                    });
                  }
                  if (e.key === 'Escape') { setNewProfileInput(''); setAddingProfile(false); }
                }}
              />
              <button
                type="button"
                className="micro-button"
                disabled={!newProfileInput.trim() || busyOp}
                title="Create this macro profile."
                onClick={() => {
                  if (!newProfileInput.trim()) return;
                  void update(() => api.addProfile(newProfileInput.trim())).then(() => {
                    setNewProfileInput(''); setAddingProfile(false);
                  });
                }}
              >✓</button>
              <button
                type="button"
                className="micro-button micro-button--danger"
                title="Cancel creating a new profile."
                onClick={() => { setNewProfileInput(''); setAddingProfile(false); }}
              >✕</button>
            </>
          ) : (
            <>
              <select
                className="macro-select macro-select--profile"
                value={state?.config.activeProfile ?? ''}
                onChange={e => void update(() => api.switchProfile(e.target.value))}
                disabled={busyOp}
                title="Choose the active macro profile to edit and use."
              >
                {state?.config.profiles.map((p: MacroProfile) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="micro-button"
                title="Add a new macro profile."
                onClick={() => setAddingProfile(true)}
              >＋</button>
              <button
                type="button"
                className="micro-button"
                title="Export the active macro profile to a JSON file."
                onClick={() => void exportActiveProfile()}
              >⇩</button>
              <button
                type="button"
                className="micro-button"
                title="Import a macro profile JSON file and switch to it."
                onClick={() => void importProfile()}
              >⇧</button>
              <button
                type="button"
                className="micro-button micro-button--danger"
                title="Delete the active macro profile. The Default profile cannot be deleted."
                disabled={state?.config.activeProfile === 'Default'}
                onClick={() => {
                  if (confirm(`Delete profile "${state?.config.activeProfile}"?`))
                    void update(() => api.deleteProfile(state!.config.activeProfile));
                }}
              >🗑</button>
            </>
          )}
        </div>

        {/* Process bindings */}
        <div className="process-bindings">
          <div className="process-bindings-header">
            <span className="process-bindings-label">Auto-switch on focus</span>
            <button
              type="button"
              className="micro-button"
              title="Refresh the list of running apps for profile auto-switch bindings."
              onClick={() => void loadActiveApps()}
              disabled={appsLoading}
            >{appsLoading ? '…' : '↺'}</button>
          </div>
          <div className="process-apps-list">
            {activeApps.map(appName => {
              const bound = profile?.processBindings?.includes(appName) ?? false;
              return (
                <div key={appName} className={`process-app-row${bound ? ' process-app-row--bound' : ''}`}>
                  <span className="process-app-name">{appName}</span>
                  <button
                    type="button"
                    className={`micro-button${bound ? ' micro-button--danger' : ''}`}
                    title={bound ? 'Remove this app from the active profile auto-switch bindings.' : 'Bind this app to the active profile so focusing it switches profiles.'}
                    onClick={() => {
                      if (!profile) return;
                      const bindings = bound
                        ? (profile.processBindings ?? []).filter(b => b !== appName)
                        : [...(profile.processBindings ?? []), appName];
                      void update(() => api.updateProcessBindings(profile.name, bindings));
                    }}
                  >{bound ? '✕' : '＋'}</button>
                </div>
              );
            })}
            {activeApps.length === 0 && !appsLoading && (
              <div className="process-apps-empty">No apps found. Click ↺ to refresh.</div>
            )}
          </div>
        </div>

        <div className="macro-runtime-panel">
          <div className="macro-runtime-header">
            <span className="process-bindings-label">Automation runtime</span>
            <button
              type="button"
              className="micro-button"
              title="Refresh runtime diagnostics now."
              onClick={() => void loadRuntime()}
            >↺</button>
          </div>
          <div className="macro-runtime-metrics">
            <span className={`status-pill status-pill--${runtime?.focusWorkerRunning ? 'enabled' : 'disabled'}`}>
              Focus worker {runtime?.focusWorkerRunning ? 'online' : 'offline'}
            </span>
            <span className={`status-pill status-pill--${runtime?.uiohookRunning ? 'enabled' : 'disabled'}`}>
              Native hook {runtime?.uiohookRunning ? 'active' : 'idle'}
            </span>
          </div>
          <div className="macro-runtime-meta">
            <span>Restarts: {runtime?.focusMonitorRestarts ?? 0}</span>
            <span>Active loops: {runtime?.activePlaybackMacros ?? 0}</span>
            <span>Queued runs: {runtime?.queuedRuns ?? 0}</span>
            <span>Last focus sample: {formatTimeAgo(runtime?.lastFocusSampleAt ?? null)}</span>
          </div>
          {(runtime?.hotkeysWithNoBackend.length ?? 0) > 0 ? (
            <div className="macro-runtime-warning">
              Unhandled hotkeys: {(runtime?.hotkeysWithNoBackend ?? []).join(', ')}
            </div>
          ) : null}
        </div>

        <div className="macro-conflicts-panel">
          <div className="macro-runtime-header">
            <span className="process-bindings-label">Hotkey conflicts</span>
            <span className={`status-pill status-pill--${hotkeyConflicts.length > 0 ? 'disabled' : 'enabled'}`}>
              {hotkeyConflicts.length > 0 ? `${hotkeyConflicts.length} found` : 'none'}
            </span>
          </div>

          {hotkeyConflicts.length === 0 ? (
            <div className="process-apps-empty">No duplicate macro hotkeys in this profile.</div>
          ) : (
            <div className="macro-conflicts-list">
              {hotkeyConflicts.map((conflict: MacroHotkeyConflict) => (
                <div key={conflict.hotkey} className="macro-conflict-item">
                  <div className="macro-conflict-title">{conflict.hotkey}</div>
                  <div className="macro-conflict-macros">{conflict.macroNames.join(', ')}</div>
                  {conflict.suggestions.length > 0 ? (
                    <div className="macro-conflict-suggestions">
                      {conflict.suggestions.map((suggestion: MacroHotkeySuggestion) => (
                        <button
                          key={`${conflict.hotkey}-${suggestion.macroId}`}
                          type="button"
                          className="ghost-button ghost-button--xs"
                          onClick={() => void applyHotkeySuggestion(suggestion)}
                          title={`Apply suggested hotkey ${suggestion.suggestedHotkey} to ${suggestion.macroName}.`}
                        >
                          Fix {suggestion.macroName || '(unnamed)'} to {suggestion.suggestedHotkey}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="process-apps-empty">No automatic suggestion available.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="macro-keyboard-panel">
          <div className="macro-runtime-header">
            <span className="process-bindings-label">Keyboard preview</span>
            <label className="macro-toggle-label" title="Experimental: disable this any time to roll back to the classic macro editor view.">
              <input
                type="checkbox"
                checked={keyboardPreviewEnabled}
                onChange={event => setKeyboardPreviewEnabled(event.target.checked)}
              />
              Experimental
            </label>
          </div>

          <div className="macro-keyboard-controls">
            <label className="macro-label" htmlFor="keyboard-layout-select">Layout</label>
            <select
              id="keyboard-layout-select"
              className="macro-select"
              value={keyboardLayoutId}
              onChange={event => setKeyboardLayoutId(event.target.value as KeyboardPreviewLayoutId)}
              disabled={!keyboardPreviewEnabled}
              title="Choose the keyboard layout used for the bound-key preview."
            >
              {Object.values(keyboardPreviewLayouts).map(layout => (
                <option key={layout.id} value={layout.id}>{layout.label}</option>
              ))}
            </select>
          </div>

          {keyboardPreviewEnabled ? (
            <KeyboardHotkeyPreview macros={allMacros} layoutId={keyboardLayoutId} />
          ) : (
            <div className="process-apps-empty">
              Enable the experimental preview to visualize all bound hotkeys on a keyboard layout.
            </div>
          )}
        </div>

        {/* Tree actions */}
        <div className="macros-tree-actions">
          <button type="button" className="ghost-button ghost-button--sm" title="Create a new macro in the active profile." onClick={() => {
            const m = blankMacro();
            void update(() => api.upsertMacro(m)).then(() => setSelectedMacroId(m.id));
          }}>＋ Macro</button>
          <button type="button" className="ghost-button ghost-button--sm" title="Create a folder for organizing macros." onClick={() => {
            const f = blankFolder();
            void update(() => api.upsertFolder(f));
          }}>📁 Folder</button>
        </div>

        {/* Error */}
        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="status-banner">{notice}</div>}

        {/* Macro tree */}
        <div className="macro-tree">
          {/* Root macros */}
          {profile?.macros.map((macro: Macro) => (
            <MacroTreeItem
              key={macro.id}
              macro={macro}
              selected={selectedMacroId === macro.id}
              running={runningId === macro.id}
              onSelect={() => setSelectedMacroId(macro.id)}
              onRun={async () => {
                setRunningId(macro.id);
                await call(() => api.runMacro(macro.id));
                setRunningId(null);
              }}
              onDelete={() => void update(() => api.deleteMacro(macro.id))}
              folders={profile.folders}
              onMove={folderId => void update(() => api.moveMacroToFolder(macro.id, folderId))}
            />
          ))}

          {/* Folders */}
          {profile?.folders.map((folder: MacroFolder) => (
            <div key={folder.id} className="macro-folder">
              <div className="macro-folder-header">
                <button
                  type="button"
                  className="macro-folder-toggle"
                  title={expandedFolders.has(folder.id) ? 'Collapse this macro folder.' : 'Expand this macro folder.'}
                  onClick={() => setExpandedFolders(prev => {
                    const next = new Set(prev);
                    if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id);
                    return next;
                  })}
                >
                  {expandedFolders.has(folder.id) ? '▾' : '▸'} 📁 {folder.name}
                </button>
                <div className="macro-folder-actions">
                  <button type="button" className="micro-button" onClick={() => {
                    const m = blankMacro();
                    void update(() => api.upsertMacro(m)).then(async () => {
                      await api.moveMacroToFolder(m.id, folder.id);
                      void refresh().then(() => setSelectedMacroId(m.id));
                    });
                  }} title="Add macro to folder">＋</button>
                  <button type="button" className="micro-button micro-button--danger" onClick={() => {
                    if (confirm(`Delete folder "${folder.name}"? Macros will be moved to root.`))
                      void update(() => api.deleteFolder(folder.id));
                  }} title="Delete folder">🗑</button>
                </div>
              </div>
              {expandedFolders.has(folder.id) && folder.macros.map((macro: Macro) => (
                <MacroTreeItem
                  key={macro.id}
                  macro={macro}
                  selected={selectedMacroId === macro.id}
                  running={runningId === macro.id}
                  indent
                  onSelect={() => setSelectedMacroId(macro.id)}
                  onRun={async () => {
                    setRunningId(macro.id);
                    await call(() => api.runMacro(macro.id));
                    setRunningId(null);
                  }}
                  onDelete={() => void update(() => api.deleteMacro(macro.id))}
                  folders={profile.folders}
                  onMove={fId => void update(() => api.moveMacroToFolder(macro.id, fId))}
                />
              ))}
            </div>
          ))}

          {(!profile?.macros.length && !profile?.folders.length) && (
            <div className="empty-state">No macros yet. Click ＋ Macro to create one.</div>
          )}
        </div>
      </div>

      {/* ── Right panel: macro editor ── */}
      <div className="macros-editor">
        {selectedMacro ? (
          <MacroEditor
            macro={selectedMacro}
            allMacros={allMacros}
            onChange={saveMacro}
            onDelete={() => {
              setSelectedMacroId(null);
              void update(() => api.deleteMacro(selectedMacro.id));
            }}
            onRun={async () => {
              setRunningId(selectedMacro.id);
              await call(() => api.runMacro(selectedMacro.id));
              setRunningId(null);
            }}
            onImportHelldiversPack={importHelldiversPack}
            running={runningId === selectedMacro.id}
          />
        ) : (
          <div className="macros-editor-empty">
            <p>Select a macro to edit, or click <strong>＋ Macro</strong> to create one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function KeyboardHotkeyPreview({
  macros,
  layoutId,
}: {
  macros: Macro[];
  layoutId: KeyboardPreviewLayoutId;
}): ReactElement {
  const layout = keyboardPreviewLayouts[layoutId];
  const aliasMap = useMemo(() => buildKeyboardAliasMap(layout), [layout]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);

  const { keyBindings, unmatchedBindings } = useMemo(() => {
    const nextKeyBindings = new Map<string, HotkeyKeyBinding[]>();
    const unmatched: HotkeyKeyBinding[] = [];

    macros.forEach(macro => {
      const parsed = extractHotkeyBinding(macro);
      if (!parsed) return;

      const keyIds = aliasMap.get(parsed.primaryToken) ?? [];
      if (keyIds.length === 0) {
        unmatched.push(parsed.binding);
        return;
      }

      keyIds.forEach(keyId => {
        const current = nextKeyBindings.get(keyId) ?? [];
        current.push(parsed.binding);
        nextKeyBindings.set(keyId, current);
      });
    });

    return { keyBindings: nextKeyBindings, unmatchedBindings: unmatched };
  }, [aliasMap, macros]);

  const boundKeyIds = useMemo(() => [...keyBindings.keys()], [keyBindings]);

  useEffect(() => {
    if (selectedKeyId && keyBindings.has(selectedKeyId)) return;
    setSelectedKeyId(boundKeyIds[0] ?? null);
  }, [boundKeyIds, keyBindings, selectedKeyId]);

  const selectedBindings = selectedKeyId ? (keyBindings.get(selectedKeyId) ?? []) : [];
  const selectedKeyLabel = selectedKeyId
    ? layout.rows.flat().find(key => key.id === selectedKeyId)?.label ?? selectedKeyId
    : null;
  const assignedHotkeyCount = macros.reduce((count, macro) => (macro.hotkey.trim() ? count + 1 : count), 0);
  const conflictKeyCount = [...keyBindings.values()].filter(list => list.length > 1).length;

  return (
    <div className="macro-keyboard-preview">
      <div className="macro-runtime-metrics">
        <span className="status-pill status-pill--enabled">{assignedHotkeyCount} assigned</span>
        <span className={`status-pill status-pill--${conflictKeyCount > 0 ? 'disabled' : 'enabled'}`}>
          {conflictKeyCount > 0 ? `${conflictKeyCount} key conflicts` : 'no key conflicts'}
        </span>
      </div>

      <div className="macro-keyboard-layout" role="grid" aria-label={`Keyboard preview (${layout.label})`}>
        {layout.rows.map((row, rowIndex) => (
          <div className="macro-keyboard-row" key={`${layout.id}-row-${rowIndex}`} role="row">
            {row.map(key => {
              const bindings = key.spacer ? [] : (keyBindings.get(key.id) ?? []);
              const style = { '--key-width-units': String(key.width ?? 1) } as CSSProperties;
              if (key.spacer) return <span key={key.id} className="macro-key macro-key--spacer" style={style} aria-hidden />;

              const detail = bindings.slice(0, 3).map(binding => binding.macroName).join(', ');
              const extra = bindings.length > 3 ? ` (+${bindings.length - 3} more)` : '';
              const title = bindings.length > 0
                ? `${key.label}: ${detail}${extra}`
                : key.label;

              return (
                <button
                  key={key.id}
                  type="button"
                  className={`macro-key${bindings.length > 0 ? ' macro-key--bound' : ''}${bindings.length > 1 ? ' macro-key--conflict' : ''}${selectedKeyId === key.id ? ' macro-key--selected' : ''}`}
                  style={style}
                  title={title}
                  onClick={() => setSelectedKeyId(key.id)}
                  role="gridcell"
                >
                  <span className="macro-key-label">{key.label}</span>
                  {bindings.length > 0 ? <span className="macro-key-count">{bindings.length}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {selectedBindings.length > 0 ? (
        <div className="macro-keyboard-details">
          <div className="macro-keyboard-details-title">Bound to {selectedKeyLabel}</div>
          <div className="macro-keyboard-binding-list">
            {selectedBindings.map(binding => (
              <div key={`${binding.macroId}-${binding.hotkey}`} className="macro-keyboard-binding-item">
                <span>{binding.macroName}</span>
                <code>{binding.hotkey}</code>
                {binding.modifiers.length > 0 ? <span className="macro-tool-hint">{binding.modifiers.join(' + ')}</span> : null}
                {!binding.enabled ? <span className="status-pill status-pill--disabled">disabled</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="process-apps-empty">Click a highlighted key to inspect bound macros.</div>
      )}

      {unmatchedBindings.length > 0 ? (
        <div className="macro-runtime-warning">
          {unmatchedBindings.length} hotkey(s) could not be mapped to this layout.
        </div>
      ) : null}
    </div>
  );
}

// ─── MacroTreeItem ─────────────────────────────────────────────────────────

function MacroTreeItem({
  macro, selected, running, indent, onSelect, onRun, onDelete, folders, onMove,
}: {
  macro: Macro;
  selected: boolean;
  running: boolean;
  indent?: boolean;
  onSelect: () => void;
  onRun: () => Promise<void>;
  onDelete: () => void;
  folders: MacroFolder[];
  onMove: (folderId: string | null) => void;
}): ReactElement {
  return (
    <div className={`macro-tree-item${selected ? ' macro-tree-item--selected' : ''}${indent ? ' macro-tree-item--indent' : ''}`}>
      <button type="button" className="macro-tree-label" onClick={onSelect} title="Select this macro for editing.">
        <span className={`macro-enabled-dot ${macro.enabled ? 'macro-enabled-dot--on' : ''}`} />
        <span className="macro-tree-name">{macro.name || '(unnamed)'}</span>
        {macro.hotkey && <code className="macro-tree-hotkey">{macro.hotkey}</code>}
      </button>
      <div className="macro-tree-item-actions">
        <button type="button" className="micro-button" onClick={e => { e.stopPropagation(); void onRun(); }} title="Run this macro now." disabled={running}>
          {running ? '⏳' : '▶'}
        </button>
        <button type="button" className="micro-button micro-button--danger" onClick={e => { e.stopPropagation(); onDelete(); }} title="Delete this macro.">
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── MacroEditor ──────────────────────────────────────────────────────────

function MacroEditor({
  macro, allMacros, onChange, onDelete, onRun, onImportHelldiversPack, running,
}: {
  macro: Macro;
  allMacros: Macro[];
  onChange: (m: Macro) => void;
  onDelete: () => void;
  onRun: () => Promise<void>;
  onImportHelldiversPack: (options: HelldiversPresetOptions) => Promise<void>;
  running: boolean;
}): ReactElement {
  const [dragSource, setDragSource] = useState<ActionDragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<ActionDropTarget | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(macroPresets[0]?.id ?? '');
  const [autoClickerOptions, setAutoClickerOptions] = useState<AutoClickerPresetOptions>(DEFAULT_AUTO_CLICKER_OPTIONS);
  const [helldiversDefaults, setHelldiversDefaults] = useState<HelldiversPresetOptions>(() => loadStoredHelldiversDefaults());
  const [helldiversOptions, setHelldiversOptions] = useState<HelldiversPresetOptions>(helldiversDefaults);
  const [helldiversSearch, setHelldiversSearch] = useState('');
  const [targetRunTimeMs, setTargetRunTimeMs] = useState(100);
  const [hoveredPairIndex, setHoveredPairIndex] = useState<number | null>(null);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const playback = normalizeMacroPlayback(macro.playback);
  const selectedPreset = macroPresets.find(item => item.id === selectedPresetId) ?? macroPresets[0];
  const selectedHelldiversStratagem = helldivers2StratagemPresets.find(item => item.id === helldiversOptions.stratagemId) ?? helldivers2StratagemPresets[0];
  const filteredHelldiversStratagems = helldivers2StratagemPresets.filter(stratagem => stratagem.name.toLowerCase().includes(helldiversSearch.trim().toLowerCase()));
  const calculatedAutoClickerDelay = autoClickerDelayMs(autoClickerOptions);
  const delayActionCount = countDelayActions(macro.actions);
  const hasLinkedActionPairs = hasActionPair(macro.actions);
  const pairDecorations = buildActionPairDecorations(macro.actions);

  useEffect(() => {
    setHotkeyError(null);
  }, [macro.id, macro.hotkey]);

  const updateAutoClickerOptions = (updates: Partial<AutoClickerPresetOptions>) => {
    setAutoClickerOptions(prev => ({ ...prev, ...updates }));
  };

  const updateHelldiversOptions = (updates: Partial<HelldiversPresetOptions>) => {
    setHelldiversOptions(prev => sanitizeHelldiversOptions({ ...prev, ...updates }));
  };

  const applyStoredHelldiversDefaults = () => {
    setHelldiversOptions(helldiversDefaults);
  };

  const saveHelldiversDefaults = () => {
    const nextDefaults = sanitizeHelldiversOptions(helldiversOptions);
    setHelldiversDefaults(nextDefaults);
    setHelldiversOptions(nextDefaults);
    persistHelldiversDefaults(nextDefaults);
  };

  const resetHelldiversDefaults = () => {
    setHelldiversDefaults(DEFAULT_HELLDIVERS_OPTIONS);
    setHelldiversOptions(DEFAULT_HELLDIVERS_OPTIONS);
    persistHelldiversDefaults(DEFAULT_HELLDIVERS_OPTIONS);
  };

  const updatePlayback = (updates: Partial<MacroPlaybackOptions>) => {
    onChange({ ...macro, playback: normalizeMacroPlayback({ ...playback, ...updates }) });
  };

  const commitHotkey = (nextHotkey: string) => {
    const trimmedHotkey = nextHotkey.trim();
    if (!trimmedHotkey) {
      setHotkeyError(null);
      onChange({ ...macro, hotkey: '' });
      return;
    }

    const normalizedHotkey = normalizeMacroHotkey(trimmedHotkey);
    const conflictMacro = allMacros.find(item => item.id !== macro.id && normalizeMacroHotkey(item.hotkey) === normalizedHotkey);
    if (conflictMacro) {
      setHotkeyError(`"${trimmedHotkey}" is already assigned to "${conflictMacro.name || '(unnamed)'}".`);
      return;
    }

    setHotkeyError(null);
    onChange({ ...macro, hotkey: trimmedHotkey });
  };

  const addAction = (type: MacroAction['type']) => {
    onChange({ ...macro, actions: [...macro.actions, blankAction(type)] });
  };

  const insertPreset = () => {
    if (!selectedPreset) return;

    const actionsToInsert = selectedPreset.createActions({
      autoClicker: autoClickerOptions,
      helldivers: helldiversOptions,
    });

    const shouldAutoNameHelldivers = selectedPreset.id === 'helldivers-2-stratagem' && selectedHelldiversStratagem;
    onChange({
      ...macro,
      name: shouldAutoNameHelldivers ? selectedHelldiversStratagem.name : macro.name,
      actions: [...macro.actions, ...actionsToInsert],
    });
  };

  const updateAction = (idx: number, updated: MacroAction, insertAfter?: MacroAction[]) => {
    onChange({ ...macro, actions: updateActionAt(macro.actions, idx, updated, insertAfter) });
  };

  const deleteAction = (idx: number) => {
    onChange({ ...macro, actions: macro.actions.filter((_: MacroAction, i: number) => i !== idx) });
  };

  const fitRunTime = () => {
    onChange({ ...macro, actions: fitDelayActionsToRunTime(macro.actions, targetRunTimeMs) });
  };

  const convertPairsToPress = () => {
    onChange({ ...macro, actions: convertActionPairsToPress(macro.actions) });
  };

  const endActionDrag = () => {
    setDragSource(null);
    setDropTarget(null);
  };

  const dragController: ActionDragController = {
    dragSource,
    dropTarget,
    startDrag: source => {
      setDragSource(source);
      setDropTarget({ listId: source.listId, index: source.index });
    },
    previewDrop: target => setDropTarget(target),
    dropAction: target => {
      if (dragSource) {
        const actions = moveActionInTree(macro.actions, dragSource, target);
        if (actions !== macro.actions) onChange({ ...macro, actions });
      }
      endActionDrag();
    },
    endDrag: endActionDrag,
  };

  return (
    <div className="macro-editor-panel">
      {/* Header */}
      <div className="macro-editor-header">
        <input
          className="macro-name-input"
          value={macro.name}
          placeholder="Macro name"
          onChange={e => onChange({ ...macro, name: e.target.value })}
          title="Name shown in the macro list."
        />
        <div className="macro-editor-header-actions">
          <label className="macro-toggle-label">
            <input
              type="checkbox"
              checked={macro.enabled}
              onChange={e => onChange({ ...macro, enabled: e.target.checked })}
              title="When disabled, the macro will not run from its hotkey."
            />
            Enabled
          </label>
          <button
            type="button"
            className="toggle-button"
            onClick={() => void onRun()}
            disabled={running}
            title="Run this macro immediately."
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
          <button type="button" className="toggle-button toggle-button--restore" onClick={onDelete} title="Delete this macro.">
            Delete
          </button>
        </div>
      </div>

      {/* Hotkey */}
      <div className="macro-field-row">
        <label className="macro-label">Global Hotkey</label>
        <HotkeyInput
          value={macro.hotkey}
          onChange={commitHotkey}
          placeholder="Click and press key combination…"
          allowModifierKeys
          allowNonAsciiKeys={false}
        />
        {macro.hotkey && (
          <button type="button" className="micro-button" onClick={() => { setHotkeyError(null); onChange({ ...macro, hotkey: '' }); }} title="Clear this macro hotkey.">✕</button>
        )}
      </div>
      {hotkeyError ? <div className="macro-inline-error">{hotkeyError}</div> : null}

      <div className="macro-playback-row">
        <label className="macro-label">Playback Option</label>
        <select
          className="macro-select macro-playback-select"
          value={playback.mode}
          onChange={e => updatePlayback({ mode: e.target.value as MacroPlaybackMode })}
          title={macroPlaybackDescriptions[playback.mode]}
        >
          {macroPlaybackModes.map(mode => (
            <option key={mode} value={mode}>{macroPlaybackLabels[mode]}</option>
          ))}
        </select>

        {playback.mode === 'multiple' ? (
          <>
            <label className="macro-label">Runs</label>
            <input
              type="number"
              className="macro-input macro-input--short"
              value={playback.repeatCount}
              min={1}
              max={10000}
              onChange={e => updatePlayback({ repeatCount: Number(e.target.value) })}
              title="How many whole macro runs this hotkey press should start."
            />
          </>
        ) : null}

      </div>

      {/* Actions list */}
      <div className="macro-actions-header">
        <span>Actions ({macro.actions.length})</span>
        <div className="macro-add-actions">
          {actionTypes.map(t => (
            <button key={t} type="button" className="ghost-button ghost-button--xs" onClick={() => addAction(t)} title={macroActionDescriptions[t]}>
              +{t}
            </button>
          ))}
        </div>
      </div>

      <div className="macro-tools-row">
        <label className="macro-label">Run time (ms)</label>
        <input
          type="number"
          className="macro-input macro-input--short"
          value={targetRunTimeMs}
          min={0}
          max={86400000}
          onChange={e => setTargetRunTimeMs(Number(e.target.value))}
          title="Target total delay time for this macro. Existing Delay nodes are evenly redistributed to match it."
        />
        <button
          type="button"
          className="ghost-button ghost-button--sm"
          onClick={fitRunTime}
          disabled={delayActionCount === 0}
          title="Evenly split the target time across every Delay action in this macro, including nested actions."
        >
          Fit Delays
        </button>
        <span className="macro-tool-hint">{delayActionCount} delay node{delayActionCount === 1 ? '' : 's'}</span>
        <button
          type="button"
          className="ghost-button ghost-button--sm"
          onClick={convertPairsToPress}
          disabled={!hasLinkedActionPairs}
          title="Convert linked Key Down/Key Up and Mouse Down/Mouse Up pairs into single Press or Click actions."
        >
          Convert Pairs to Press
        </button>
      </div>

      <div className="macro-preset-panel">
        <div className="macro-preset-row">
          <label className="macro-label">Preset</label>
          <select
            className="macro-select macro-preset-select"
            value={selectedPresetId}
            onChange={e => setSelectedPresetId(e.target.value)}
            title="Choose a common macro preset to insert into this macro."
          >
            {macroPresets.map(preset => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="ghost-button ghost-button--sm"
            onClick={insertPreset}
            title={selectedPreset?.description ?? 'Insert the selected preset.'}
          >
            Insert Preset
          </button>
        </div>

        {selectedPresetId === 'auto-clicker' ? (
          <div className="macro-preset-options">
            <label className="macro-label">Clicks</label>
            <input
              type="number"
              className="macro-input macro-input--short"
              value={autoClickerOptions.repeatCount}
              min={1}
              max={10000}
              onChange={e => updateAutoClickerOptions({ repeatCount: Number(e.target.value) })}
              title="How many clicks the inserted repeat block should contain."
            />
            <div className="macro-preset-mode" role="group" aria-label="Auto Clicker timing mode">
              <button
                type="button"
                className={`macro-preset-mode-button${autoClickerOptions.timingMode === 'delay' ? ' macro-preset-mode-button--active' : ''}`}
                onClick={() => updateAutoClickerOptions({ timingMode: 'delay' })}
                title="Use an explicit delay after each click."
              >
                Delay
              </button>
              <button
                type="button"
                className={`macro-preset-mode-button${autoClickerOptions.timingMode === 'cps' ? ' macro-preset-mode-button--active' : ''}`}
                onClick={() => updateAutoClickerOptions({ timingMode: 'cps' })}
                title="Calculate the delay from a target clicks-per-second rate."
              >
                Target CPS
              </button>
            </div>
            {autoClickerOptions.timingMode === 'delay' ? (
              <>
                <label className="macro-label">Delay (ms)</label>
                <input
                  type="number"
                  className="macro-input macro-input--short"
                  value={autoClickerOptions.delayMs}
                  min={0}
                  max={60000}
                  onChange={e => updateAutoClickerOptions({ delayMs: Number(e.target.value) })}
                  title="Delay after each click. Use 0 for the fastest inserted preset."
                />
              </>
            ) : (
              <>
                <label className="macro-label">CPS</label>
                <input
                  type="number"
                  className="macro-input macro-input--short"
                  value={autoClickerOptions.clicksPerSecond}
                  min={0.1}
                  max={10000}
                  step={0.1}
                  onChange={e => updateAutoClickerOptions({ clicksPerSecond: Number(e.target.value) })}
                  title="Target clicks per second for the inserted repeat block."
                />
                <span className="macro-preset-calculated" title="Target interval between click starts for this preset.">
                  {calculatedAutoClickerDelay} ms interval
                </span>
              </>
            )}
          </div>
        ) : null}
        {selectedPresetId === 'helldivers-2-stratagem' ? (
          <div className="macro-preset-options macro-preset-options--helldivers">
            <div className="helldivers-preset-toolbar">
              <input
                className="macro-input macro-input--search"
                value={helldiversSearch}
                placeholder="Search stratagem..."
                onChange={event => setHelldiversSearch(event.target.value)}
                title="Filter the Helldivers stratagem list by name."
              />
              <button
                type="button"
                className="ghost-button ghost-button--sm"
                onClick={() => applyStoredHelldiversDefaults()}
                title="Use your saved Helldivers default values for this preset."
              >
                Use Defaults
              </button>
              <button
                type="button"
                className="ghost-button ghost-button--sm"
                onClick={() => saveHelldiversDefaults()}
                title="Save the current Helldivers options as your defaults."
              >
                Save as Defaults
              </button>
              <button
                type="button"
                className="ghost-button ghost-button--sm"
                onClick={() => resetHelldiversDefaults()}
                title="Reset Helldivers defaults back to the built-in values."
              >
                Reset Defaults
              </button>
              <button
                type="button"
                className="ghost-button ghost-button--sm"
                onClick={() => void onImportHelldiversPack(helldiversOptions)}
                title="Create one macro per listed stratagem in a new profile folder."
              >
                Create Full Pack ({helldivers2StratagemPresets.length})
              </button>
            </div>

            <div className="helldivers-preset-grid">
              <label className="macro-label">Stratagem</label>
              <select
                className="macro-select"
                value={helldiversOptions.stratagemId}
                onChange={event => updateHelldiversOptions({ stratagemId: event.target.value })}
                title="Choose the stratagem code to insert."
              >
                {helldivers2StratagemPresets.map(stratagem => (
                  <option key={stratagem.id} value={stratagem.id}>{stratagem.name}</option>
                ))}
              </select>

              <label className="macro-label">Direction keys</label>
              <div className="macro-preset-mode" role="group" aria-label="Helldivers direction key mode">
                <button
                  type="button"
                  className={`macro-preset-mode-button${helldiversOptions.movementKeys === 'arrows' ? ' macro-preset-mode-button--active' : ''}`}
                  onClick={() => updateHelldiversOptions({ movementKeys: 'arrows' })}
                  title="Use Arrow keys for direction input."
                >
                  Arrows
                </button>
                <button
                  type="button"
                  className={`macro-preset-mode-button${helldiversOptions.movementKeys === 'wasd' ? ' macro-preset-mode-button--active' : ''}`}
                  onClick={() => updateHelldiversOptions({ movementKeys: 'wasd' })}
                  title="Use W A S D for direction input."
                >
                  WASD
                </button>
              </div>

              <label className="macro-label">Modifier key</label>
              <select
                className="macro-select"
                value={helldiversOptions.modifierKey}
                onChange={event => updateHelldiversOptions({ modifierKey: event.target.value as HelldiversModifierKey })}
                title="Key used to open stratagem input in-game."
              >
                <option value="Ctrl">Ctrl</option>
                <option value="Alt">Alt</option>
                <option value="Shift">Shift</option>
                <option value="none">None</option>
              </select>

              <label className="macro-label">Modifier behavior</label>
              <div className="macro-preset-mode" role="group" aria-label="Helldivers modifier behavior">
                <button
                  type="button"
                  className={`macro-preset-mode-button${helldiversOptions.modifierBehavior === 'hold' ? ' macro-preset-mode-button--active' : ''}`}
                  onClick={() => updateHelldiversOptions({ modifierBehavior: 'hold' })}
                  title="Hold the modifier for the whole stratagem input, then release it."
                >
                  Hold
                </button>
                <button
                  type="button"
                  className={`macro-preset-mode-button${helldiversOptions.modifierBehavior === 'press' ? ' macro-preset-mode-button--active' : ''}`}
                  onClick={() => updateHelldiversOptions({ modifierBehavior: 'press' })}
                  title="Tap the modifier once before entering the stratagem sequence."
                >
                  Press
                </button>
              </div>

              <label className="macro-label">Step delay (ms)</label>
              <input
                type="number"
                className="macro-input macro-input--short"
                min={0}
                max={2000}
                value={helldiversOptions.keyDelayMs}
                onChange={event => updateHelldiversOptions({ keyDelayMs: Number(event.target.value) })}
                title="Delay between each directional key press."
              />

              <label className="macro-label">Modifier lead-in (ms)</label>
              <input
                type="number"
                className="macro-input macro-input--short"
                min={0}
                max={2000}
                value={helldiversOptions.modifierLeadInMs}
                onChange={event => updateHelldiversOptions({ modifierLeadInMs: Number(event.target.value) })}
                title="Pause between modifier input and first direction."
              />
            </div>

            {selectedHelldiversStratagem ? (
              <div className="helldivers-preview-row">
                <span className="macro-tool-hint">Selected code</span>
                <code className="helldivers-code-preview">{formatHelldiversCode(selectedHelldiversStratagem.code)}</code>
              </div>
            ) : null}

            <div className="helldivers-list-header">
              <span>Current stratagem codes ({filteredHelldiversStratagems.length}/{helldivers2StratagemPresets.length})</span>
            </div>
            <div className="helldivers-code-list">
              {filteredHelldiversStratagems.map(stratagem => (
                <button
                  key={stratagem.id}
                  type="button"
                  className={`helldivers-code-row${helldiversOptions.stratagemId === stratagem.id ? ' helldivers-code-row--active' : ''}`}
                  onClick={() => updateHelldiversOptions({ stratagemId: stratagem.id })}
                  title="Select this stratagem preset."
                >
                  <span className="helldivers-code-name">{stratagem.name}</span>
                  <code className="helldivers-code-value">{formatHelldiversCode(stratagem.code)}</code>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="macro-actions-list">
        {macro.actions.length === 0 && (
          <div
            className={`empty-state nested-actions-empty-drop${dropTarget?.listId === ROOT_ACTION_LIST_ID ? ' nested-actions-empty-drop--active' : ''}`}
            onDragOver={event => {
              event.preventDefault();
              dragController.previewDrop({ listId: ROOT_ACTION_LIST_ID, index: 0 });
            }}
            onDrop={event => {
              event.preventDefault();
              dragController.dropAction({ listId: ROOT_ACTION_LIST_ID, index: 0 });
            }}
          >No actions yet. Add one above.</div>
        )}
        {macro.actions.map((action, idx) => {
          const decoration = pairDecorations.get(action.id);
          return (
          <div
            key={action.id}
            className={`${actionDropClass('action-wrapper', ROOT_ACTION_LIST_ID, idx, dropTarget)}${decoration ? ` action-wrapper--linked action-wrapper--linked-${decoration.role}${hoveredPairIndex === decoration.pairIndex ? ' action-wrapper--linked-hover' : ''}` : ''}`}
            style={actionPairStyle(decoration)}
            draggable
            onMouseEnter={() => setHoveredPairIndex(decoration?.pairIndex ?? null)}
            onMouseLeave={() => setHoveredPairIndex(null)}
            onDragStart={event => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', action.id);
              dragController.startDrag({ actionId: action.id, listId: ROOT_ACTION_LIST_ID, index: idx });
            }}
            onDragOver={(event) => {
              event.preventDefault();
              dragController.previewDrop({ listId: ROOT_ACTION_LIST_ID, index: dropIndexForEvent(event, idx) });
            }}
            onDrop={(event) => {
              event.preventDefault();
              dragController.dropAction({ listId: ROOT_ACTION_LIST_ID, index: dropIndexForEvent(event, idx) });
            }}
            onDragEnd={dragController.endDrag}
          >
            <div className="action-reorder" title="Drag to reorder">
              <span className="action-drag-handle">⋮⋮</span>
              <span className="action-index">{idx + 1}</span>
            </div>
            <ActionEditor
              action={action}
              onChange={(updated, insertAfter) => updateAction(idx, updated, insertAfter)}
              onDelete={() => deleteAction(idx)}
              pairDecoration={actionPairRole(action) ? decoration : undefined}
              dragController={dragController}
            />
          </div>
          );
        })}
        {macro.actions.length > 0 ? (
          <div
            className={`action-drop-end${dropTarget?.listId === ROOT_ACTION_LIST_ID && dropTarget.index === macro.actions.length ? ' action-drop-end--active' : ''}`}
            onDragOver={event => {
              event.preventDefault();
              dragController.previewDrop({ listId: ROOT_ACTION_LIST_ID, index: macro.actions.length });
            }}
            onDrop={event => {
              event.preventDefault();
              dragController.dropAction({ listId: ROOT_ACTION_LIST_ID, index: macro.actions.length });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
