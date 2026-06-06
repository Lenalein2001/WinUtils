export type FileSyncMode =
  | 'left-to-right-update'
  | 'left-to-right-mirror'
  | 'right-to-left-update'
  | 'right-to-left-mirror'
  | 'two-way';

export type FileSyncCompareMode = 'size-time' | 'hash';
export type FileSyncConflictPolicy = 'manual' | 'newer' | 'left' | 'right' | 'keep-both';
export type FileSyncTriggerType = 'manual' | 'interval' | 'on-change' | 'on-startup' | 'path-available' | 'logoff' | 'schedule';
export type FileSyncAutomationMode = 'analyze' | 'sync';
export type FileSyncAutomationStatus = 'idle' | 'running' | 'analyzed' | 'applied' | 'partial' | 'failed' | 'blocked' | 'skipped';

export interface FileSyncFilters {
  includePatterns: string[];
  excludePatterns: string[];
  excludeHidden: boolean;
  excludeSystem: boolean;
  excludeEmptyFolders: boolean;
  maxFileSizeBytes?: number;
}

export interface FileSyncOptions {
  compareMode: FileSyncCompareMode;
  verifyCopies: boolean;
  quarantineDeletes: boolean;
  keepVersions: boolean;
  conflictPolicy: FileSyncConflictPolicy;
  createMissingFolders: boolean;
  detectMoves: boolean;
  copyCreationTime: boolean;
  copySecurityBits: boolean;
  copyLockedFiles: boolean;
  symbolicLinks: 'ignore' | 'copy-as-is' | 'drill-down';
}

export interface FileSyncTrigger {
  id: string;
  type: FileSyncTriggerType;
  enabled: boolean;
  intervalMinutes?: number;
  debounceSeconds?: number;
  mode?: FileSyncAutomationMode;
}

export interface FileSyncJob {
  id: string;
  name: string;
  leftPath: string;
  rightPath: string;
  mode: FileSyncMode;
  filters: FileSyncFilters;
  options: FileSyncOptions;
  triggers: FileSyncTrigger[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: FileSyncRunStatus;
}

export type FileSyncRunStatus = 'analyzed' | 'applied' | 'partial' | 'failed';

export interface FileSyncJobInput {
  name?: string;
  leftPath?: string;
  rightPath?: string;
  mode?: FileSyncMode;
  filters?: Partial<FileSyncFilters>;
  options?: Partial<FileSyncOptions>;
  triggers?: FileSyncTrigger[];
}

export interface FileSyncState {
  jobs: FileSyncJob[];
  recentRuns: FileSyncRunSummary[];
  automation: FileSyncAutomationState[];
}

export interface FileSyncAutomationState {
  jobId: string;
  running: boolean;
  enabledTriggers: FileSyncTriggerType[];
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastTrigger?: FileSyncTriggerType;
  lastStatus?: FileSyncAutomationStatus;
  lastMessage?: string;
  nextRunAt?: string;
}

export type FileSyncSide = 'left' | 'right';
export type FileSyncItemKind = 'file' | 'directory';

export interface FileSyncEntryInfo {
  path: string;
  relativePath: string;
  kind: FileSyncItemKind;
  size: number;
  modifiedAt: string;
  hash?: string;
}

export type FileSyncAction =
  | 'copy-left-to-right'
  | 'copy-right-to-left'
  | 'update-left-to-right'
  | 'update-right-to-left'
  | 'quarantine-left'
  | 'quarantine-right'
  | 'create-directory-left'
  | 'create-directory-right'
  | 'quarantine-directory-left'
  | 'quarantine-directory-right'
  | 'keep-both'
  | 'equal'
  | 'conflict'
  | 'skip'
  | 'error';

export type FileSyncPreviewStatus = 'ready' | 'unchanged' | 'warning' | 'conflict' | 'error' | 'skipped';

export interface FileSyncPreviewRow {
  id: string;
  relativePath: string;
  kind: FileSyncItemKind;
  action: FileSyncAction;
  status: FileSyncPreviewStatus;
  reason: string;
  left?: FileSyncEntryInfo;
  right?: FileSyncEntryInfo;
  issues: string[];
}

export interface FileSyncPreviewCounts {
  total: number;
  ready: number;
  unchanged: number;
  conflicts: number;
  warnings: number;
  errors: number;
  skipped: number;
  copyLeftToRight: number;
  copyRightToLeft: number;
  quarantine: number;
}

export interface FileSyncAnalyzeResult {
  job: FileSyncJob;
  rows: FileSyncPreviewRow[];
  counts: FileSyncPreviewCounts;
  analyzedAt: string;
}

export interface FileSyncRunOperation {
  relativePath: string;
  action: FileSyncAction;
  status: 'applied' | 'failed' | 'skipped';
  message?: string;
  sourcePath?: string;
  targetPath?: string;
  quarantinePath?: string;
}

export interface FileSyncRunSummary {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  status: FileSyncRunStatus;
  trigger: FileSyncTriggerType;
  analyzed: FileSyncPreviewCounts;
  appliedCount: number;
  failedCount: number;
}

export interface FileSyncApplyResult extends FileSyncRunSummary {
  operations: FileSyncRunOperation[];
}

export interface FileSyncSnapshotEntry {
  relativePath: string;
  left?: Pick<FileSyncEntryInfo, 'kind' | 'size' | 'modifiedAt' | 'hash'>;
  right?: Pick<FileSyncEntryInfo, 'kind' | 'size' | 'modifiedAt' | 'hash'>;
}

export interface FileSyncJobSnapshot {
  jobId: string;
  updatedAt: string;
  entries: Record<string, FileSyncSnapshotEntry>;
}

export interface FileSyncStoreFile {
  version: 1;
  jobs: FileSyncJob[];
  recentRuns: FileSyncApplyResult[];
  syncStates?: Record<string, FileSyncJobSnapshot>;
}
