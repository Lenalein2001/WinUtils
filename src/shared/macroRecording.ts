export type RecordedInputEvent = { timeUs: number } & (
  | { kind: 'key'; key: number; scan: number; extended: boolean; up: boolean }
  | { kind: 'button'; button: number; up: boolean }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'wheel'; delta: number; horizontal: boolean }
);

export interface MacroTimeline {
  version: 1;
  events: RecordedInputEvent[];
  speed: number;
  timing: 'preserve-timing' | 'preserve-schedule';
  metadata: { backend: 'windows-hooks'; frequency: number; dropped: number; repaired: number; excluded: number; layout: string; displays?: string };
}
export interface MacroRecordingOptions {
  keyboard: boolean;
  mouse: boolean;
  movement: boolean;
  countdownSeconds: number;
  excludedProcesses: string[];
}
export interface MacroRecordingState {
  phase: 'idle' | 'countdown' | 'recording' | 'ready';
  eventCount: number;
  dropped: number;
  elapsedMs: number;
  countdownMs: number;
  error: string | null;
  draft: MacroTimeline | null;
}

export function recordedKeyLabel(key: number): string {
  if (key >= 65 && key <= 90 || key >= 48 && key <= 57) return String.fromCharCode(key);
  if (key >= 112 && key <= 135) return `F${key - 111}`;
  if (key >= 96 && key <= 105) return `Num ${key - 96}`;
  const names: Record<number, string> = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 19: 'Pause', 20: 'Caps Lock', 27: 'Esc', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 44: 'Print Screen', 45: 'Insert', 46: 'Delete', 91: 'Left Win', 92: 'Right Win', 160: 'Left Shift', 161: 'Right Shift', 162: 'Left Ctrl', 163: 'Right Ctrl', 164: 'Left Alt', 165: 'Right Alt' };
  return names[key] ?? `Key 0x${key.toString(16).toUpperCase()}`;
}
