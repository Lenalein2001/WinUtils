// ─── Macro action types ────────────────────────────────────────────────────

export type KeyPressType = 'press' | 'down' | 'up';
export type MouseButton = 'left' | 'right' | 'middle';
export type MouseActionType = 'click' | 'double-click' | 'down' | 'up' | 'move';
export type MacroConditionSource = 'active-process' | 'active-window-title' | 'clipboard-text' | 'file-exists' | 'key-state';
export type MacroConditionOperator = 'contains' | 'equals' | 'matches' | 'not-contains' | 'not-equals' | 'not-matches' | 'exists' | 'not-exists' | 'is-pressed' | 'is-not-pressed';
export type MacroPlaybackMode = 'once' | 'multiple' | 'toggle' | 'while-pressed' | 'queue';

export interface MacroPlaybackOptions {
  mode: MacroPlaybackMode;
  repeatCount: number;
}

export const DEFAULT_MACRO_PLAYBACK: MacroPlaybackOptions = {
  mode: 'once',
  repeatCount: 2,
};

export function normalizeMacroPlayback(playback: Partial<MacroPlaybackOptions> | null | undefined): MacroPlaybackOptions {
  const rawMode = (playback as { mode?: string } | null | undefined)?.mode;
  const mode = rawMode === 'multiple' || rawMode === 'toggle' || rawMode === 'queue'
    ? rawMode
    : rawMode === 'while-pressed' || rawMode === 'while-held'
      ? 'while-pressed'
    : 'once';
  const repeatCount = Math.trunc(Number(playback?.repeatCount));

  return {
    mode,
    repeatCount: Number.isFinite(repeatCount) ? Math.max(1, Math.min(10000, repeatCount)) : DEFAULT_MACRO_PLAYBACK.repeatCount,
  };
}

export interface MacroCondition {
  source: MacroConditionSource;
  operator: MacroConditionOperator;
  value: string;
  caseSensitive: boolean;
}

export interface DelayAction {
  id: string;
  type: 'delay';
  enabled: boolean;
  milliseconds: number;
}

export interface KeyboardAction {
  id: string;
  type: 'keyboard';
  enabled: boolean;
  key: string; // e.g. "Ctrl+C", "Enter"
  pressType: KeyPressType;
}

export interface MouseAction {
  id: string;
  type: 'mouse';
  enabled: boolean;
  button: MouseButton;
  actionType: MouseActionType;
  x?: number;
  y?: number;
}

export interface LaunchAction {
  id: string;
  type: 'launch';
  enabled: boolean;
  path: string;
  arguments: string;
}

export interface CommandAction {
  id: string;
  type: 'command';
  enabled: boolean;
  command: string;
  workingDirectory: string;
}

export interface TextAction {
  id: string;
  type: 'text';
  enabled: boolean;
  text: string;
}

export interface RepeatAction {
  id: string;
  type: 'repeat';
  enabled: boolean;
  times: number;
  actions: MacroAction[];
}

export interface IfAction {
  id: string;
  type: 'if';
  enabled: boolean;
  condition: MacroCondition;
  thenActions: MacroAction[];
  elseActions: MacroAction[];
}

export type MacroAction =
  | DelayAction
  | KeyboardAction
  | MouseAction
  | LaunchAction
  | CommandAction
  | TextAction
  | RepeatAction
  | IfAction;

// ─── Macro ────────────────────────────────────────────────────────────────

export interface Macro {
  id: string;
  name: string;
  hotkey: string; // e.g. "Ctrl+Alt+M"
  actions: MacroAction[];
  enabled: boolean;
  playback: MacroPlaybackOptions;
}

// ─── Folder ───────────────────────────────────────────────────────────────

export interface MacroFolder {
  id: string;
  name: string;
  macros: Macro[];
  isExpanded: boolean;
}

// ─── Profile ──────────────────────────────────────────────────────────────

export interface MacroProfile {
  name: string;
  folders: MacroFolder[];
  macros: Macro[];
  /** Process names (without .exe) that auto-activate this profile when focused. */
  processBindings?: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────

export interface MacroConfig {
  activeProfile: string;
  profiles: MacroProfile[];
  recordToggleHotkey: string;
}

// ─── IPC payload shapes ───────────────────────────────────────────────────

export interface MacroState {
  config: MacroConfig;
  /** Flat list of all macros in the active profile (root + folders). */
  allMacros: Macro[];
  activeProfile: MacroProfile;
}
