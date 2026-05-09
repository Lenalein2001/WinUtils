// ─── Macro action types ────────────────────────────────────────────────────

export type KeyPressType = 'press' | 'down' | 'up';
export type MouseButton = 'left' | 'right' | 'middle';
export type MouseActionType = 'click' | 'double-click' | 'down' | 'up' | 'move';

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

export type MacroAction =
  | DelayAction
  | KeyboardAction
  | MouseAction
  | LaunchAction
  | CommandAction
  | TextAction;

// ─── Macro ────────────────────────────────────────────────────────────────

export interface Macro {
  id: string;
  name: string;
  hotkey: string; // e.g. "Ctrl+Alt+M"
  actions: MacroAction[];
  enabled: boolean;
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
