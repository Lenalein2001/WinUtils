import type { AutomationActionDefinition } from './actions';

export type HotkeyBindingSource = 'feature' | 'macro' | 'action';
export type HotkeyBindingBackend = 'native-worker' | 'native-polling' | 'none';
export type HotkeyBindingStatus = 'active' | 'disabled' | 'internal-conflict' | 'os-registration-failed';

export interface HotkeyBinding {
  id: string;
  actionId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  description: string;
  hotkey: string;
  normalizedHotkey: string;
  enabled: boolean;
  available: boolean;
  editable: boolean;
  source: HotkeyBindingSource;
  backend: HotkeyBindingBackend;
  status: HotkeyBindingStatus;
  registrationError?: string;
}

export interface HotkeyConflict {
  hotkey: string;
  normalizedHotkey: string;
  bindingIds: string[];
  labels: string[];
}

export interface HotkeyState {
  bindings: HotkeyBinding[];
  conflicts: HotkeyConflict[];
  actions: AutomationActionDefinition[];
}

export interface HotkeyUpdateInput {
  bindingId: string;
  hotkey: string;
  enabled: boolean;
  replaceConflicts?: boolean;
}

export interface HotkeyUpdateResult {
  ok: boolean;
  state: HotkeyState;
  conflicts: HotkeyConflict[];
  error?: string;
}

export interface HotkeyActionBindingInput {
  actionId: string;
  hotkey: string;
}

const modifierOrder = ['ctrl', 'alt', 'shift', 'win'];

export function normalizeHotkey(raw: string): string {
  const tokens = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .filter(Boolean)
    .map(normalizeHotkeyToken);

  if (tokens.length === 0) return '';

  const modifiers = modifierOrder.filter(modifier => tokens.includes(modifier));
  const keys = tokens.filter(token => !modifierOrder.includes(token));
  return [...modifiers, ...keys].join('+');
}

export function formatHotkey(raw: string): string {
  return normalizeHotkey(raw)
    .split('+')
    .filter(Boolean)
    .map(token => {
      if (token === 'ctrl') return 'Ctrl';
      if (token === 'alt') return 'Alt';
      if (token === 'shift') return 'Shift';
      if (token === 'win') return 'Win';
      if (/^f\d{1,2}$/.test(token)) return token.toUpperCase();
      if (/^num\d$/.test(token)) return `NumPad${token.slice(3)}`;
      if (token === 'numadd') return 'NumPadAdd';
      if (token === 'numsub') return 'NumPadSubtract';
      if (token === 'nummult') return 'NumPadMultiply';
      if (token === 'numdiv') return 'NumPadDivide';
      if (token === 'numdec') return 'NumPadDecimal';
      if (token === 'numenter') return 'NumPadEnter';
      return token.length === 1 ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1);
    })
    .join('+');
}

function normalizeHotkeyToken(token: string): string {
  if (token === 'control' || token === 'commandorcontrol' || token === 'cmdorctrl') return 'ctrl';
  if (token === 'meta' || token === 'super' || token === 'windows' || token === 'os') return 'win';
  if (token === 'option') return 'alt';

  const numpadDigit = token.match(/^(?:num|numpad)([0-9])$/)?.[1];
  if (numpadDigit) return `num${numpadDigit}`;

  if (token === 'numdecimal' || token === 'numpaddecimal' || token === 'num.') return 'numdec';
  if (token === 'numpadadd' || token === 'num+') return 'numadd';
  if (token === 'numsubtract' || token === 'numpadsubtract' || token === 'num-') return 'numsub';
  if (token === 'nummultiply' || token === 'numpadmultiply' || token === 'num*') return 'nummult';
  if (token === 'numdivide' || token === 'numpaddivide' || token === 'num/') return 'numdiv';
  if (token === 'numpadenter') return 'numenter';
  if (token === 'esc') return 'escape';
  if (token === 'return') return 'enter';
  if (token === 'ins') return 'insert';
  if (token === 'del') return 'delete';
  if (token === 'pgup') return 'pageup';
  if (token === 'pgdn') return 'pagedown';
  if (token.startsWith('arrow')) return token.slice(5);
  return token;
}
