export type ManagedWindowState = 'normal' | 'minimized' | 'maximized';
export type WindowPlacementPreset =
  | 'left-half'
  | 'right-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'fullscreen';

export interface ManagedDisplay {
  id: string;
  label: string;
  primary: boolean;
  scaleFactor: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

export interface ManagedWindow {
  id: string;
  processId: number;
  processName: string;
  processPath: string | null;
  title: string;
  state: ManagedWindowState;
  hidden: boolean;
  alwaysOnTop: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  displayId: string | null;
}

export interface WindowManagerState {
  windows: ManagedWindow[];
  displays: ManagedDisplay[];
  layouts: SavedWindowLayout[];
  refreshedAt: string;
}

export type WindowCommand =
  | { type: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'hide' | 'show'; windowId: string }
  | { type: 'set-always-on-top'; windowId: string; enabled: boolean }
  | { type: 'move-resize'; windowId: string; x: number; y: number; width: number; height: number }
  | { type: 'apply-preset'; windowId: string; displayId: string; preset: WindowPlacementPreset };

export interface WindowCommandResult {
  ok: boolean;
  error?: string;
  state: WindowManagerState;
}

export interface SavedWindowPlacement {
  processName: string;
  title: string;
  displayId: string | null;
  relativeBounds: { x: number; y: number; width: number; height: number };
  state: ManagedWindowState;
  alwaysOnTop: boolean;
}

export interface SavedWindowLayout {
  id: string;
  name: string;
  createdAt: string;
  placements: SavedWindowPlacement[];
}

export interface SaveWindowLayoutInput {
  name: string;
  windowIds: string[];
}

export interface WindowLayoutApplyResult {
  ok: boolean;
  applied: number;
  unmatched: string[];
  errors: string[];
  state: WindowManagerState;
}
