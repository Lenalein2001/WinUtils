export type AlwaysActiveMode = 'active-signal' | 'game-keepalive' | 'prevent-deactivation' | 'keep-foreground';

export interface AlwaysActiveSettings {
  enabled: boolean;
  pollIntervalMs: number;
  pausedUntil: string | null;
}

export interface AlwaysActiveRule {
  id: string;
  label: string;
  enabled: boolean;
  mode: AlwaysActiveMode;
  processName: string;
  processPath: string;
  title: string;
  restoreMinimized: boolean;
  createdAt: string;
  updatedAt: string;
  lastMatchedAt?: string;
}

export interface AlwaysActiveWindow {
  id: string;
  hwnd: string;
  processId: number;
  processName: string;
  processPath: string;
  title: string;
  threadId: number;
  isForeground: boolean;
  isMinimized: boolean;
  isVisible: boolean;
  ruleIds: string[];
}

export interface AlwaysActiveForegroundWindow {
  hwnd: string;
  processId: number;
  processName: string;
  processPath: string;
  title: string;
}

export interface AlwaysActiveWorkerStatus {
  supported: boolean;
  running: boolean;
  error: string | null;
  lastStartedAt: string | null;
  lastAppliedAt: string | null;
  lastAppliedRuleIds: string[];
  lastActionCount: number;
}

export interface AlwaysActiveState {
  settings: AlwaysActiveSettings;
  rules: AlwaysActiveRule[];
  windows: AlwaysActiveWindow[];
  foregroundWindow: AlwaysActiveForegroundWindow | null;
  workerStatus: AlwaysActiveWorkerStatus;
}

export interface AlwaysActiveRuleUpdate {
  id: string;
  label?: string;
  enabled?: boolean;
  mode?: AlwaysActiveMode;
  restoreMinimized?: boolean;
}
