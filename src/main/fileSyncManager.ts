import { createHash, randomUUID } from 'node:crypto';
import { existsSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type {
  FileSyncAction,
  FileSyncAnalyzeResult,
  FileSyncApplyResult,
  FileSyncAutomationState,
  FileSyncAutomationStatus,
  FileSyncCompareMode,
  FileSyncConflictPolicy,
  FileSyncEntryInfo,
  FileSyncFilters,
  FileSyncJobSnapshot,
  FileSyncJob,
  FileSyncJobInput,
  FileSyncMode,
  FileSyncOptions,
  FileSyncPreviewCounts,
  FileSyncPreviewRow,
  FileSyncPreviewStatus,
  FileSyncRunOperation,
  FileSyncRunStatus,
  FileSyncState,
  FileSyncStoreFile,
  FileSyncTrigger,
  FileSyncTriggerType,
} from '../shared/fileSync';

const FILE_SCAN_CONCURRENCY = 24;
const MTIME_EQUAL_TOLERANCE_MS = 2_000;
const RECENT_RUN_LIMIT = 30;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_CHANGE_DEBOUNCE_SECONDS = 8;
const PATH_AVAILABLE_POLL_MS = 60_000;
const STARTUP_TRIGGER_DELAY_MS = 8_000;

const DEFAULT_FILTERS: FileSyncFilters = {
  includePatterns: [],
  excludePatterns: ['node_modules/**', '.git/**', 'Thumbs.db', 'desktop.ini'],
  excludeHidden: true,
  excludeSystem: true,
  excludeEmptyFolders: false,
};

const DEFAULT_OPTIONS: FileSyncOptions = {
  compareMode: 'size-time',
  verifyCopies: true,
  quarantineDeletes: true,
  keepVersions: true,
  conflictPolicy: 'manual',
  createMissingFolders: true,
  detectMoves: false,
  copyCreationTime: false,
  copySecurityBits: false,
  copyLockedFiles: false,
  symbolicLinks: 'ignore',
};

interface ScanResult {
  entries: Map<string, FileSyncEntryInfo>;
  errors: Array<{ relativePath: string; message: string }>;
}

interface StoreRunResult {
  status: FileSyncRunStatus;
  appliedCount: number;
  failedCount: number;
}

interface FileSyncManagerOptions {
  onStateChanged?: () => void;
}

interface AutomationRuntime {
  timers: NodeJS.Timeout[];
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  pathAvailableSeen: boolean;
}

export class FileSyncManager {
  private cache: FileSyncStoreFile | null = null;
  private readonly automation = new Map<string, AutomationRuntime>();
  private readonly automationState = new Map<string, FileSyncAutomationState>();
  private readonly activeRuns = new Set<string>();
  private destroyed = false;

  constructor(private readonly options: FileSyncManagerOptions = {}) {}

  async init(): Promise<void> {
    await this.load();
    await this.refreshAutomation();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearAutomation();
  }

  async getState(): Promise<FileSyncState> {
    const store = await this.load();
    return {
      jobs: store.jobs,
      recentRuns: store.recentRuns.map(({ operations: _operations, ...summary }) => summary),
      automation: this.buildAutomationState(store.jobs),
    };
  }

  async createJob(input: FileSyncJobInput = {}): Promise<FileSyncState> {
    const store = await this.load();
    const now = new Date().toISOString();
    const job: FileSyncJob = {
      id: randomUUID(),
      name: input.name?.trim() || 'New file sync job',
      leftPath: input.leftPath?.trim() ?? '',
      rightPath: input.rightPath?.trim() ?? '',
      mode: input.mode ?? 'left-to-right-update',
      filters: normalizeFilters(input.filters),
      options: normalizeOptions(input.options),
      triggers: normalizeTriggers(input.triggers),
      createdAt: now,
      updatedAt: now,
    };

    store.jobs = [job, ...store.jobs];
    await this.save(store);
    await this.refreshAutomation();
    this.emitStateChanged();
    return this.getState();
  }

  async updateJob(id: string, input: FileSyncJobInput): Promise<FileSyncState> {
    const store = await this.load();
    const job = store.jobs.find((item) => item.id === id);
    if (!job) throw new Error('The selected file sync job could not be found.');

    Object.assign(job, {
      name: input.name !== undefined ? input.name.trim() || job.name : job.name,
      leftPath: input.leftPath !== undefined ? input.leftPath.trim() : job.leftPath,
      rightPath: input.rightPath !== undefined ? input.rightPath.trim() : job.rightPath,
      mode: input.mode ?? job.mode,
      filters: input.filters ? normalizeFilters({ ...job.filters, ...input.filters }) : job.filters,
      options: input.options ? normalizeOptions({ ...job.options, ...input.options }) : job.options,
      triggers: input.triggers ? normalizeTriggers(input.triggers) : job.triggers,
      updatedAt: new Date().toISOString(),
    });

    await this.save(store);
    await this.refreshAutomation();
    this.emitStateChanged();
    return this.getState();
  }

  async deleteJob(id: string): Promise<FileSyncState> {
    const store = await this.load();
    const nextJobs = store.jobs.filter((job) => job.id !== id);
    if (nextJobs.length === store.jobs.length) throw new Error('The selected file sync job could not be found.');
    store.jobs = nextJobs;
    await this.save(store);
    await this.refreshAutomation();
    this.emitStateChanged();
    return this.getState();
  }

  async analyze(jobId: string): Promise<FileSyncAnalyzeResult> {
    const job = await this.getJob(jobId);
    validateJob(job);

    const [leftScan, rightScan] = await Promise.all([
      this.scanEndpoint(job.leftPath, job.filters, job.options),
      this.scanEndpoint(job.rightPath, job.filters, job.options),
    ]);

    const snapshot = (await this.load()).syncStates?.[job.id];
    const rows = this.buildPreviewRows(job, leftScan, rightScan, snapshot);
    return {
      job,
      rows,
      counts: countRows(rows),
      analyzedAt: new Date().toISOString(),
    };
  }

  async apply(jobId: string, trigger: FileSyncTriggerType = 'manual'): Promise<FileSyncApplyResult> {
    if (this.activeRuns.has(jobId)) throw new Error('This file sync job is already running.');
    this.activeRuns.add(jobId);
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    try {
      const preview = await this.analyze(jobId);

      if (preview.counts.conflicts > 0 || preview.counts.errors > 0) {
        throw new Error('Resolve file sync conflicts and errors before applying changes.');
      }

      const operations: FileSyncRunOperation[] = [];
      for (const row of preview.rows) {
        operations.push(await this.applyRow(preview.job, runId, row));
      }

      const failedCount = operations.filter((operation) => operation.status === 'failed').length;
      const appliedCount = operations.filter((operation) => operation.status === 'applied').length;
      const status: FileSyncRunStatus = failedCount > 0 ? (appliedCount > 0 ? 'partial' : 'failed') : 'applied';
      const result: FileSyncApplyResult = {
        id: runId,
        jobId: preview.job.id,
        jobName: preview.job.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        trigger,
        analyzed: preview.counts,
        appliedCount,
        failedCount,
        operations,
      };

      await this.storeRun(preview.job.id, result);
      if (status === 'applied') await this.storeSnapshot(preview.job);
      this.emitStateChanged();
      return result;
    } finally {
      this.activeRuns.delete(jobId);
    }
  }

  private async applyRow(job: FileSyncJob, runId: string, row: FileSyncPreviewRow): Promise<FileSyncRunOperation> {
    try {
      if (row.action === 'copy-left-to-right' || row.action === 'update-left-to-right') {
        if (!row.left) throw new Error('Missing left-side source file.');
        const targetPath = safeJoin(job.rightPath, row.relativePath);
        await this.copyFileSafely(row.left.path, targetPath, job, runId, 'right', row.relativePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', sourcePath: row.left.path, targetPath };
      }

      if (row.action === 'copy-right-to-left' || row.action === 'update-right-to-left') {
        if (!row.right) throw new Error('Missing right-side source file.');
        const targetPath = safeJoin(job.leftPath, row.relativePath);
        await this.copyFileSafely(row.right.path, targetPath, job, runId, 'left', row.relativePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', sourcePath: row.right.path, targetPath };
      }

      if (row.action === 'quarantine-left') {
        if (!row.left) throw new Error('Missing left-side file to quarantine.');
        const quarantinePath = await this.quarantinePath(job, runId, 'left', row.relativePath);
        await moveFile(row.left.path, quarantinePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath: row.left.path, quarantinePath };
      }

      if (row.action === 'quarantine-right') {
        if (!row.right) throw new Error('Missing right-side file to quarantine.');
        const quarantinePath = await this.quarantinePath(job, runId, 'right', row.relativePath);
        await moveFile(row.right.path, quarantinePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath: row.right.path, quarantinePath };
      }

      if (row.action === 'create-directory-left') {
        const targetPath = safeJoin(job.leftPath, row.relativePath);
        await mkdir(targetPath, { recursive: true });
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath };
      }

      if (row.action === 'create-directory-right') {
        const targetPath = safeJoin(job.rightPath, row.relativePath);
        await mkdir(targetPath, { recursive: true });
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath };
      }

      if (row.action === 'quarantine-directory-left') {
        if (!row.left) throw new Error('Missing left-side folder to quarantine.');
        if (!(await isDirectoryEmpty(row.left.path))) throw new Error('Folder is no longer empty; re-run Analyze before syncing.');
        const quarantinePath = await this.quarantinePath(job, runId, 'left', row.relativePath);
        await moveFile(row.left.path, quarantinePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath: row.left.path, quarantinePath };
      }

      if (row.action === 'quarantine-directory-right') {
        if (!row.right) throw new Error('Missing right-side folder to quarantine.');
        if (!(await isDirectoryEmpty(row.right.path))) throw new Error('Folder is no longer empty; re-run Analyze before syncing.');
        const quarantinePath = await this.quarantinePath(job, runId, 'right', row.relativePath);
        await moveFile(row.right.path, quarantinePath);
        return { relativePath: row.relativePath, action: row.action, status: 'applied', targetPath: row.right.path, quarantinePath };
      }

      if (row.action === 'keep-both') {
        if (!row.left || !row.right) throw new Error('Missing one side of the keep-both conflict.');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rightConflictPath = await nextAvailablePath(safeJoin(job.rightPath, conflictCopyName(row.relativePath, 'left', timestamp)));
        const leftConflictPath = await nextAvailablePath(safeJoin(job.leftPath, conflictCopyName(row.relativePath, 'right', timestamp)));
        await this.copyFileSafely(row.left.path, rightConflictPath, job, runId, 'right', path.relative(job.rightPath, rightConflictPath));
        await this.copyFileSafely(row.right.path, leftConflictPath, job, runId, 'left', path.relative(job.leftPath, leftConflictPath));
        return {
          relativePath: row.relativePath,
          action: row.action,
          status: 'applied',
          sourcePath: row.left.path,
          targetPath: `${rightConflictPath}; ${leftConflictPath}`,
          message: 'Copied both conflicting versions with side-specific conflict-copy names.',
        };
      }

      return { relativePath: row.relativePath, action: row.action, status: 'skipped', message: row.reason };
    } catch (error) {
      return {
        relativePath: row.relativePath,
        action: row.action,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async copyFileSafely(
    sourcePath: string,
    targetPath: string,
    job: FileSyncJob,
    runId: string,
    targetSide: 'left' | 'right',
    relativePath: string,
  ): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });

    const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.winutils-${randomUUID()}.tmp`);
    let backupPath: string | null = null;
    try {
      const sourceStatsBeforeCopy = await stat(sourcePath);
      await copyFile(sourcePath, tempPath);
      const [sourceStatsAfterCopy, tempStats] = await Promise.all([stat(sourcePath), stat(tempPath)]);
      if (!sameFileVersion(sourceStatsBeforeCopy, sourceStatsAfterCopy)) {
        throw new Error('Source file changed while it was being copied; re-run Analyze before syncing.');
      }

      if (job.options.verifyCopies) {
        if (sourceStatsBeforeCopy.size !== tempStats.size) throw new Error('Copied file size verification failed.');
        const [sourceHash, tempHash] = await Promise.all([hashFile(sourcePath), hashFile(tempPath)]);
        if (sourceHash !== tempHash) throw new Error('Copied file checksum verification failed.');
      }

      if (existsSync(targetPath)) {
        backupPath = await this.quarantinePath(job, runId, targetSide, relativePath);
        await moveFile(targetPath, backupPath);
      }

      await rename(tempPath, targetPath);
      await applyCopiedFileMetadata(targetPath, sourceStatsBeforeCopy);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (backupPath && existsSync(backupPath) && !existsSync(targetPath)) {
        await moveFile(backupPath, targetPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async quarantinePath(job: FileSyncJob, runId: string, side: 'left' | 'right', relativePath: string): Promise<string> {
    const safeJobName = sanitizePathSegment(job.name || job.id);
    const sideRoot = path.join(this.quarantineRoot, safeJobName, runId, side);
    let targetPath = safeJoin(sideRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (!existsSync(targetPath)) return targetPath;

    const parsed = path.parse(targetPath);
    targetPath = path.join(parsed.dir, `${parsed.name}.${Date.now()}${parsed.ext}`);
    return targetPath;
  }

  private buildPreviewRows(job: FileSyncJob, leftScan: ScanResult, rightScan: ScanResult, snapshot?: FileSyncJobSnapshot): FileSyncPreviewRow[] {
    const rows: FileSyncPreviewRow[] = [];
    for (const error of leftScan.errors) {
      rows.push(createErrorRow(error.relativePath, `Left side: ${error.message}`));
    }
    for (const error of rightScan.errors) {
      rows.push(createErrorRow(error.relativePath, `Right side: ${error.message}`));
    }

    const keys = Array.from(new Set([...leftScan.entries.keys(), ...rightScan.entries.keys()])).sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      const left = leftScan.entries.get(key);
      const right = rightScan.entries.get(key);
      rows.push(classifyRow(job, left?.relativePath ?? right?.relativePath ?? key, left, right, snapshot?.entries[key]));
    }

    return rows;
  }

  private async scanEndpoint(rootPath: string, filters: FileSyncFilters, options: FileSyncOptions): Promise<ScanResult> {
    const entries = new Map<string, FileSyncEntryInfo>();
    const errors: Array<{ relativePath: string; message: string }> = [];
    const visitedDirectories = new Set<string>();
    const pending: Array<() => Promise<void>> = [];
    if (!existsSync(rootPath)) return { entries, errors };

    const walk = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
      let resolvedDirectory;
      try {
        resolvedDirectory = await realpath(directoryPath);
      } catch (error) {
        errors.push({ relativePath: relativeDirectory || '.', message: errorMessage(error, 'Unable to resolve directory.') });
        return;
      }

      const normalizedResolved = normalizePathKey(resolvedDirectory);
      if (visitedDirectories.has(normalizedResolved)) return;
      visitedDirectories.add(normalizedResolved);

      let dirents;
      try {
        dirents = await readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        errors.push({ relativePath: relativeDirectory || '.', message: errorMessage(error, 'Unable to read directory.') });
        return;
      }

      if (relativeDirectory && dirents.length === 0 && !filters.excludeEmptyFolders && matchesDirectoryFilters(relativeDirectory, filters)) {
        try {
          entries.set(relativeDirectory.toLowerCase(), {
            path: directoryPath,
            relativePath: relativeDirectory,
            kind: 'directory',
            size: 0,
            modifiedAt: (await lstat(directoryPath)).mtime.toISOString(),
          });
        } catch (error) {
          errors.push({ relativePath: relativeDirectory, message: errorMessage(error, 'Unable to read folder metadata.') });
        }
      }

      const childDirectories: Array<{ absolutePath: string; relativePath: string }> = [];
      for (const dirent of dirents) {
        const absolutePath = path.join(directoryPath, dirent.name);
        const relativePath = normalizeRelativePath(path.join(relativeDirectory, dirent.name));

        if (dirent.isSymbolicLink()) {
          if (options.symbolicLinks === 'ignore') continue;
          errors.push({ relativePath, message: 'Symbolic-link and junction syncing is not supported yet; skipped for safety.' });
          continue;
        }

        if (dirent.isDirectory()) {
          childDirectories.push({ absolutePath, relativePath });
          continue;
        }

        if (!dirent.isFile()) continue;
        if (!matchesFilters(relativePath, filters)) continue;

        pending.push(async () => {
          try {
            const info = await this.readEntryInfo(absolutePath, relativePath, options.compareMode);
            if (filters.maxFileSizeBytes !== undefined && info.size > filters.maxFileSizeBytes) return;
            entries.set(relativePath.toLowerCase(), info);
          } catch (error) {
            errors.push({ relativePath, message: errorMessage(error, 'Unable to read file metadata.') });
          }
        });
      }

      for (const child of childDirectories) {
        if (!matchesDirectoryFilters(child.relativePath, filters)) continue;
        await walk(child.absolutePath, child.relativePath);
      }
    };

    await walk(rootPath, '');
    await runWithConcurrency(pending, FILE_SCAN_CONCURRENCY, async (task) => task());
    return { entries, errors };
  }

  private async readEntryInfo(filePath: string, relativePath: string, compareMode: FileSyncCompareMode): Promise<FileSyncEntryInfo> {
    const stats = await lstat(filePath);
    return {
      path: filePath,
      relativePath,
      kind: 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      hash: compareMode === 'hash' ? await hashFile(filePath) : undefined,
    };
  }

  private async getJob(jobId: string): Promise<FileSyncJob> {
    const store = await this.load();
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('The selected file sync job could not be found.');
    return job;
  }

  private async storeRun(jobId: string, result: FileSyncApplyResult): Promise<StoreRunResult> {
    const store = await this.load();
    const job = store.jobs.find((item) => item.id === jobId);
    if (job) {
      job.lastRunAt = result.finishedAt;
      job.lastRunStatus = result.status;
      job.updatedAt = result.finishedAt;
    }

    store.recentRuns = [result, ...store.recentRuns.filter((run) => run.id !== result.id)].slice(0, RECENT_RUN_LIMIT);
    await this.save(store);
    return {
      status: result.status,
      appliedCount: result.appliedCount,
      failedCount: result.failedCount,
    };
  }

  private async storeSnapshot(job: FileSyncJob): Promise<void> {
    const [leftScan, rightScan] = await Promise.all([
      this.scanEndpoint(job.leftPath, job.filters, job.options),
      this.scanEndpoint(job.rightPath, job.filters, job.options),
    ]);

    if (leftScan.errors.length > 0 || rightScan.errors.length > 0) return;

    const entries: FileSyncJobSnapshot['entries'] = {};
    const keys = Array.from(new Set([...leftScan.entries.keys(), ...rightScan.entries.keys()]));
    for (const key of keys) {
      const left = leftScan.entries.get(key);
      const right = rightScan.entries.get(key);
      entries[key] = {
        relativePath: left?.relativePath ?? right?.relativePath ?? key,
        left: left ? snapshotEntry(left) : undefined,
        right: right ? snapshotEntry(right) : undefined,
      };
    }

    const store = await this.load();
    store.syncStates = {
      ...store.syncStates,
      [job.id]: {
        jobId: job.id,
        updatedAt: new Date().toISOString(),
        entries,
      },
    };
    await this.save(store);
  }

  private async refreshAutomation(): Promise<void> {
    if (this.destroyed) return;

    const store = await this.load();
    this.clearAutomation();

    const jobIds = new Set(store.jobs.map((job) => job.id));
    for (const jobId of Array.from(this.automationState.keys())) {
      if (!jobIds.has(jobId)) this.automationState.delete(jobId);
    }

    for (const job of store.jobs) {
      const enabledTriggers = automationTriggers(job.triggers);
      this.setAutomationState(job.id, {
        jobId: job.id,
        running: false,
        enabledTriggers: enabledTriggers.map((trigger) => trigger.type),
      });

      if (enabledTriggers.length === 0) continue;

      const runtime: AutomationRuntime = {
        timers: [],
        watchers: [],
        debounceTimer: null,
        pathAvailableSeen: endpointsAvailable(job),
      };

      for (const trigger of enabledTriggers) {
        if (trigger.type === 'interval') {
          const intervalMinutes = safeIntervalMinutes(trigger.intervalMinutes);
          const intervalMs = intervalMinutes * 60_000;
          this.setAutomationState(job.id, {
            nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
          });
          runtime.timers.push(setInterval(() => {
            this.setAutomationState(job.id, { nextRunAt: new Date(Date.now() + intervalMs).toISOString() });
            void this.runAutomated(job.id, 'interval');
          }, intervalMs));
        }

        if (trigger.type === 'on-startup') {
          runtime.timers.push(setTimeout(() => {
            void this.runAutomated(job.id, 'on-startup');
          }, STARTUP_TRIGGER_DELAY_MS));
        }

        if (trigger.type === 'path-available') {
          runtime.timers.push(setInterval(async () => {
            const currentJob = await this.getJob(job.id).catch(() => null);
            if (!currentJob) return;
            const available = endpointsAvailable(currentJob);
            if (available && !runtime.pathAvailableSeen) void this.runAutomated(job.id, 'path-available');
            runtime.pathAvailableSeen = available;
          }, PATH_AVAILABLE_POLL_MS));
        }

        if (trigger.type === 'on-change') {
          for (const watchPath of [job.leftPath, job.rightPath]) {
            if (!watchPath || !existsSync(watchPath)) continue;
            try {
              runtime.watchers.push(watch(watchPath, { recursive: true }, () => {
                const debounceSeconds = safeDebounceSeconds(trigger.debounceSeconds);
                if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
                runtime.debounceTimer = setTimeout(() => {
                  runtime.debounceTimer = null;
                  void this.runAutomated(job.id, 'on-change');
                }, debounceSeconds * 1000);
              }));
            } catch (error) {
              this.setAutomationState(job.id, {
                lastStatus: 'failed',
                lastMessage: `Unable to watch ${watchPath}: ${errorMessage(error, 'watch failed')}`,
              });
            }
          }
        }
      }

      this.automation.set(job.id, runtime);
    }
  }

  private clearAutomation(): void {
    for (const runtime of this.automation.values()) {
      for (const timer of runtime.timers) clearTimeout(timer);
      for (const watcher of runtime.watchers) watcher.close();
      if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    }
    this.automation.clear();
  }

  private async runAutomated(jobId: string, triggerType: FileSyncTriggerType): Promise<void> {
    if (this.destroyed) return;

    const currentState = this.automationState.get(jobId);
    if (currentState?.running || this.activeRuns.has(jobId)) {
      this.setAutomationState(jobId, {
        lastTrigger: triggerType,
        lastStatus: 'skipped',
        lastMessage: 'Skipped because this job is already running.',
      });
      return;
    }

    const job = await this.getJob(jobId).catch(() => null);
    if (!job) return;

    const trigger = job.triggers.find((item) => item.type === triggerType && item.enabled);
    if (!trigger) return;

    this.setAutomationState(job.id, {
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastTrigger: triggerType,
      lastStatus: 'running',
      lastMessage: 'Automation is running.',
    });

    try {
      const mode = trigger.mode ?? 'sync';
      const preview = await this.analyze(job.id);

      if (mode === 'analyze') {
        this.setAutomationState(job.id, {
          lastStatus: preview.counts.conflicts > 0 || preview.counts.errors > 0 ? 'blocked' : 'analyzed',
          lastMessage: summarizeAutomationPreview(preview),
        });
        return;
      }

      if (job.lastRunStatus !== 'applied') {
        this.setAutomationState(job.id, {
          lastStatus: 'blocked',
          lastMessage: 'Run this job manually once successfully before automation can sync files.',
        });
        return;
      }

      if (preview.counts.conflicts > 0 || preview.counts.errors > 0) {
        this.setAutomationState(job.id, {
          lastStatus: 'blocked',
          lastMessage: summarizeAutomationPreview(preview),
        });
        return;
      }

      const actionableCount = preview.counts.copyLeftToRight + preview.counts.copyRightToLeft + preview.counts.quarantine;
      if (actionableCount === 0) {
        this.setAutomationState(job.id, {
          lastStatus: 'skipped',
          lastMessage: 'No file changes to sync.',
        });
        return;
      }

      const result = await this.apply(job.id, triggerType);
      this.setAutomationState(job.id, {
        lastStatus: result.status,
        lastMessage: `Applied ${result.appliedCount} operation(s); ${result.failedCount} failed.`,
      });
    } catch (error) {
      this.setAutomationState(job.id, {
        lastStatus: 'failed',
        lastMessage: errorMessage(error, 'Automation failed.'),
      });
    } finally {
      this.setAutomationState(job.id, {
        running: false,
        lastFinishedAt: new Date().toISOString(),
      });
      this.emitStateChanged();
    }
  }

  private setAutomationState(jobId: string, patch: Partial<FileSyncAutomationState>): void {
    const previous = this.automationState.get(jobId);
    this.automationState.set(jobId, {
      jobId,
      running: previous?.running ?? false,
      enabledTriggers: previous?.enabledTriggers ?? [],
      ...previous,
      ...patch,
    });
  }

  private buildAutomationState(jobs: FileSyncJob[]): FileSyncAutomationState[] {
    return jobs.map((job) => {
      const enabledTriggers = automationTriggers(job.triggers).map((trigger) => trigger.type);
      const existing = this.automationState.get(job.id);
      return {
        jobId: job.id,
        running: existing?.running ?? false,
        enabledTriggers,
        lastStartedAt: existing?.lastStartedAt,
        lastFinishedAt: existing?.lastFinishedAt,
        lastTrigger: existing?.lastTrigger,
        lastStatus: existing?.lastStatus ?? (enabledTriggers.length > 0 ? 'idle' : undefined),
        lastMessage: existing?.lastMessage,
        nextRunAt: existing?.nextRunAt,
      };
    });
  }

  private emitStateChanged(): void {
    this.options.onStateChanged?.();
  }

  private get storePath(): string {
    return path.join(app.getPath('userData'), 'file-sync.json');
  }

  private get quarantineRoot(): string {
    return path.join(app.getPath('userData'), 'file-sync-quarantine');
  }

  private async load(): Promise<FileSyncStoreFile> {
    if (this.cache) return this.cache;
    await mkdir(path.dirname(this.storePath), { recursive: true });

    if (!existsSync(this.storePath)) {
      this.cache = createEmptyStore();
      await this.save(this.cache);
      return this.cache;
    }

    const rawStore = await readFile(this.storePath, 'utf8');
    let parsed: Partial<FileSyncStoreFile>;
    try {
      parsed = JSON.parse(rawStore) as Partial<FileSyncStoreFile>;
    } catch {
      await backupCorruptStore(this.storePath);
      this.cache = createEmptyStore();
      await this.save(this.cache);
      return this.cache;
    }

    this.cache = {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeJob).filter((job): job is FileSyncJob => job !== null) : [],
      recentRuns: Array.isArray(parsed.recentRuns) ? parsed.recentRuns.map(normalizeRun) : [],
      syncStates: normalizeSyncStates(parsed.syncStates),
    };
    return this.cache;
  }

  private async save(store: FileSyncStoreFile): Promise<void> {
    this.cache = store;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
      await rename(tempPath, this.storePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function validateJob(job: FileSyncJob): void {
  if (!job.leftPath || !job.rightPath) throw new Error('Choose both left and right folders before analyzing.');
  if (normalizePathKey(job.leftPath) === normalizePathKey(job.rightPath)) throw new Error('Left and right folders must be different.');
  if (isNestedPath(job.leftPath, job.rightPath) || isNestedPath(job.rightPath, job.leftPath)) {
    throw new Error('Left and right folders cannot be nested inside each other.');
  }
  const leftExists = existsSync(job.leftPath);
  const rightExists = existsSync(job.rightPath);
  if (!leftExists && !rightExists) throw new Error('At least one sync folder must exist.');
  if (!leftExists && !job.options.createMissingFolders) throw new Error('The left folder does not exist.');
  if (!rightExists && !job.options.createMissingFolders) throw new Error('The right folder does not exist.');
}

function classifyRow(job: FileSyncJob, relativePath: string, left?: FileSyncEntryInfo, right?: FileSyncEntryInfo, previous?: FileSyncJobSnapshot['entries'][string]): FileSyncPreviewRow {
  if (left && right) {
    if (entriesEqual(left, right, job.options.compareMode)) {
      return createRow(relativePath, left, right, 'equal', 'unchanged', 'Files match.', []);
    }

    return classifyChangedPair(job, relativePath, left, right, previous);
  }

  if (left) {
    const copyAction: FileSyncAction = left.kind === 'directory' ? 'create-directory-right' : 'copy-left-to-right';
    const quarantineAction: FileSyncAction = left.kind === 'directory' ? 'quarantine-directory-left' : 'quarantine-left';
    if (job.mode === 'right-to-left-mirror') return createRow(relativePath, left, right, quarantineAction, 'warning', `Only exists on left; mirror mode will move ${left.kind === 'directory' ? 'the empty folder' : 'it'} to quarantine.`, []);
    if (job.mode === 'right-to-left-update') return createRow(relativePath, left, right, 'skip', 'skipped', 'Only exists on left; right-to-left update leaves extra left files untouched.', []);
    if (job.mode === 'two-way' && previous?.right) {
      const leftChanged = previous.left ? !entryMatchesSnapshot(left, previous.left, job.options.compareMode) : true;
      if (leftChanged) {
        return createRow(relativePath, left, right, 'conflict', 'conflict', 'Right side was deleted but left side changed since the last sync.', ['Choose a conflict policy or restore one side manually.']);
      }
      return createRow(relativePath, left, right, quarantineAction, 'warning', `Right-side deletion will be propagated by moving the left ${left.kind === 'directory' ? 'empty folder' : 'file'} to quarantine.`, []);
    }
    return createRow(relativePath, left, right, copyAction, job.mode === 'two-way' ? 'warning' : 'ready', `Only exists on left; will ${left.kind === 'directory' ? 'create the empty folder on' : 'copy to'} right.`, []);
  }

  if (right) {
    const copyAction: FileSyncAction = right.kind === 'directory' ? 'create-directory-left' : 'copy-right-to-left';
    const quarantineAction: FileSyncAction = right.kind === 'directory' ? 'quarantine-directory-right' : 'quarantine-right';
    if (job.mode === 'left-to-right-mirror') return createRow(relativePath, left, right, quarantineAction, 'warning', `Only exists on right; mirror mode will move ${right.kind === 'directory' ? 'the empty folder' : 'it'} to quarantine.`, []);
    if (job.mode === 'left-to-right-update') return createRow(relativePath, left, right, 'skip', 'skipped', 'Only exists on right; left-to-right update leaves extra right files untouched.', []);
    if (job.mode === 'two-way' && previous?.left) {
      const rightChanged = previous.right ? !entryMatchesSnapshot(right, previous.right, job.options.compareMode) : true;
      if (rightChanged) {
        return createRow(relativePath, left, right, 'conflict', 'conflict', 'Left side was deleted but right side changed since the last sync.', ['Choose a conflict policy or restore one side manually.']);
      }
      return createRow(relativePath, left, right, quarantineAction, 'warning', `Left-side deletion will be propagated by moving the right ${right.kind === 'directory' ? 'empty folder' : 'file'} to quarantine.`, []);
    }
    return createRow(relativePath, left, right, copyAction, job.mode === 'two-way' ? 'warning' : 'ready', `Only exists on right; will ${right.kind === 'directory' ? 'create the empty folder on' : 'copy to'} left.`, []);
  }

  return createErrorRow(relativePath, 'File was not found on either side.');
}

function classifyChangedPair(job: FileSyncJob, relativePath: string, left: FileSyncEntryInfo, right: FileSyncEntryInfo, previous?: FileSyncJobSnapshot['entries'][string]): FileSyncPreviewRow {
  if (left.kind !== right.kind) {
    return createRow(relativePath, left, right, 'conflict', 'conflict', 'One side is a file and the other side is a folder.', ['Rename or remove one side before syncing.']);
  }

  if (job.mode.startsWith('left-to-right')) {
    return createRow(relativePath, left, right, 'update-left-to-right', 'ready', 'Changed on one or both sides; left side will replace right side.', []);
  }

  if (job.mode.startsWith('right-to-left')) {
    return createRow(relativePath, left, right, 'update-right-to-left', 'ready', 'Changed on one or both sides; right side will replace left side.', []);
  }

  const leftChanged = previous?.left ? !entryMatchesSnapshot(left, previous.left, job.options.compareMode) : true;
  const rightChanged = previous?.right ? !entryMatchesSnapshot(right, previous.right, job.options.compareMode) : true;

  if (previous && leftChanged && !rightChanged) {
    return createRow(relativePath, left, right, 'update-left-to-right', 'warning', 'Only left changed since the last sync; left replaces right.', []);
  }

  if (previous && rightChanged && !leftChanged) {
    return createRow(relativePath, left, right, 'update-right-to-left', 'warning', 'Only right changed since the last sync; right replaces left.', []);
  }

  if (previous && !leftChanged && !rightChanged) {
    return createRow(relativePath, left, right, 'equal', 'unchanged', 'Known two-way difference is unchanged since the last successful sync.', []);
  }

  if (job.options.conflictPolicy === 'newer') {
    return Date.parse(left.modifiedAt) >= Date.parse(right.modifiedAt)
      ? createRow(relativePath, left, right, 'update-left-to-right', 'warning', 'Two-way conflict resolved by newer timestamp: left replaces right.', [])
      : createRow(relativePath, left, right, 'update-right-to-left', 'warning', 'Two-way conflict resolved by newer timestamp: right replaces left.', []);
  }

  if (job.options.conflictPolicy === 'left') {
    return createRow(relativePath, left, right, 'update-left-to-right', 'warning', 'Two-way conflict resolved by policy: left replaces right.', []);
  }

  if (job.options.conflictPolicy === 'right') {
    return createRow(relativePath, left, right, 'update-right-to-left', 'warning', 'Two-way conflict resolved by policy: right replaces left.', []);
  }

  if (job.options.conflictPolicy === 'keep-both') {
    return createRow(relativePath, left, right, 'keep-both', 'warning', 'Two-way conflict resolved by keeping both versions with conflict-copy names.', []);
  }

  return createRow(relativePath, left, right, 'conflict', 'conflict', 'Changed on both sides; choose a conflict policy before syncing.', ['Manual conflict resolution is required.']);
}

function entriesEqual(left: FileSyncEntryInfo, right: FileSyncEntryInfo, compareMode: FileSyncCompareMode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'directory') return true;
  if (compareMode === 'hash' && left.hash && right.hash) return left.hash === right.hash;
  const leftTime = Date.parse(left.modifiedAt);
  const rightTime = Date.parse(right.modifiedAt);
  return left.size === right.size && Math.abs(leftTime - rightTime) <= MTIME_EQUAL_TOLERANCE_MS;
}

function entryMatchesSnapshot(
  entry: FileSyncEntryInfo,
  snapshot: Pick<FileSyncEntryInfo, 'kind' | 'size' | 'modifiedAt' | 'hash'>,
  compareMode: FileSyncCompareMode,
): boolean {
  if (entry.kind !== snapshot.kind) return false;
  if (entry.kind === 'directory') return true;
  if (compareMode === 'hash' && entry.hash && snapshot.hash) return entry.hash === snapshot.hash;
  const entryTime = Date.parse(entry.modifiedAt);
  const snapshotTime = Date.parse(snapshot.modifiedAt);
  return entry.size === snapshot.size && Math.abs(entryTime - snapshotTime) <= MTIME_EQUAL_TOLERANCE_MS;
}

function createRow(
  relativePath: string,
  left: FileSyncEntryInfo | undefined,
  right: FileSyncEntryInfo | undefined,
  action: FileSyncAction,
  status: FileSyncPreviewStatus,
  reason: string,
  issues: string[],
): FileSyncPreviewRow {
  return {
    id: `${action}:${relativePath}`,
    relativePath,
    kind: left?.kind ?? right?.kind ?? 'file',
    action,
    status,
    reason,
    left,
    right,
    issues,
  };
}

function createErrorRow(relativePath: string, message: string): FileSyncPreviewRow {
  return createRow(relativePath, undefined, undefined, 'error', 'error', message, [message]);
}

function countRows(rows: FileSyncPreviewRow[]): FileSyncPreviewCounts {
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === 'ready').length,
    unchanged: rows.filter((row) => row.status === 'unchanged').length,
    conflicts: rows.filter((row) => row.status === 'conflict').length,
    warnings: rows.filter((row) => row.status === 'warning').length,
    errors: rows.filter((row) => row.status === 'error').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
    copyLeftToRight: rows.filter((row) => row.action === 'copy-left-to-right' || row.action === 'update-left-to-right' || row.action === 'create-directory-right' || row.action === 'keep-both').length,
    copyRightToLeft: rows.filter((row) => row.action === 'copy-right-to-left' || row.action === 'update-right-to-left' || row.action === 'create-directory-left' || row.action === 'keep-both').length,
    quarantine: rows.filter((row) => row.action === 'quarantine-left' || row.action === 'quarantine-right' || row.action === 'quarantine-directory-left' || row.action === 'quarantine-directory-right').length,
  };
}

function normalizeJob(job: FileSyncJob): FileSyncJob | null {
  if (!job || typeof job.id !== 'string') return null;
  return {
    ...job,
    name: job.name || 'File sync job',
    leftPath: job.leftPath || '',
    rightPath: job.rightPath || '',
    mode: normalizeMode(job.mode),
    filters: normalizeFilters(job.filters),
    options: normalizeOptions(job.options),
    triggers: normalizeTriggers(job.triggers),
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || job.createdAt || new Date().toISOString(),
  };
}

function createEmptyStore(): FileSyncStoreFile {
  return { version: 1, jobs: [], recentRuns: [], syncStates: {} };
}

async function backupCorruptStore(storePath: string): Promise<void> {
  const backupPath = `${storePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(storePath, backupPath);
}

function normalizeRun(run: FileSyncApplyResult): FileSyncApplyResult {
  return {
    ...run,
    trigger: normalizeTriggerType(run.trigger) ?? 'manual',
    operations: Array.isArray(run.operations) ? run.operations : [],
  };
}

function normalizeSyncStates(syncStates: FileSyncStoreFile['syncStates'] | undefined): Record<string, FileSyncJobSnapshot> {
  if (!syncStates || typeof syncStates !== 'object') return {};
  const normalized: Record<string, FileSyncJobSnapshot> = {};
  for (const [jobId, snapshot] of Object.entries(syncStates)) {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.jobId !== 'string' || !snapshot.entries) continue;
    normalized[jobId] = {
      jobId: snapshot.jobId,
      updatedAt: snapshot.updatedAt || new Date().toISOString(),
      entries: snapshot.entries,
    };
  }
  return normalized;
}

function normalizeMode(mode: FileSyncMode | undefined): FileSyncMode {
  return mode === 'left-to-right-update'
    || mode === 'left-to-right-mirror'
    || mode === 'right-to-left-update'
    || mode === 'right-to-left-mirror'
    || mode === 'two-way'
    ? mode
    : 'left-to-right-update';
}

function normalizeFilters(filters: Partial<FileSyncFilters> | undefined): FileSyncFilters {
  return {
    includePatterns: normalizePatternList(filters?.includePatterns),
    excludePatterns: normalizePatternList(filters?.excludePatterns ?? DEFAULT_FILTERS.excludePatterns),
    excludeHidden: filters?.excludeHidden ?? DEFAULT_FILTERS.excludeHidden,
    excludeSystem: filters?.excludeSystem ?? DEFAULT_FILTERS.excludeSystem,
    excludeEmptyFolders: filters?.excludeEmptyFolders ?? DEFAULT_FILTERS.excludeEmptyFolders,
    maxFileSizeBytes: Number.isFinite(filters?.maxFileSizeBytes) && Number(filters?.maxFileSizeBytes) > 0 ? Number(filters?.maxFileSizeBytes) : undefined,
  };
}

function normalizeOptions(options: Partial<FileSyncOptions> | undefined): FileSyncOptions {
  return {
    compareMode: options?.compareMode === 'hash' ? 'hash' : DEFAULT_OPTIONS.compareMode,
    verifyCopies: options?.verifyCopies ?? DEFAULT_OPTIONS.verifyCopies,
    quarantineDeletes: true,
    keepVersions: options?.keepVersions ?? DEFAULT_OPTIONS.keepVersions,
    conflictPolicy: normalizeConflictPolicy(options?.conflictPolicy),
    createMissingFolders: options?.createMissingFolders ?? DEFAULT_OPTIONS.createMissingFolders,
    detectMoves: DEFAULT_OPTIONS.detectMoves,
    copyCreationTime: options?.copyCreationTime ?? DEFAULT_OPTIONS.copyCreationTime,
    copySecurityBits: options?.copySecurityBits ?? DEFAULT_OPTIONS.copySecurityBits,
    copyLockedFiles: options?.copyLockedFiles ?? DEFAULT_OPTIONS.copyLockedFiles,
    symbolicLinks: DEFAULT_OPTIONS.symbolicLinks,
  };
}

function normalizeConflictPolicy(value: FileSyncConflictPolicy | undefined): FileSyncConflictPolicy {
  return value === 'manual' || value === 'newer' || value === 'left' || value === 'right' || value === 'keep-both'
    ? value
    : DEFAULT_OPTIONS.conflictPolicy;
}

function normalizeTriggers(triggers: FileSyncTrigger[] | undefined): FileSyncTrigger[] {
  const normalized: FileSyncTrigger[] = [];
  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    const type = normalizeTriggerType(trigger.type);
    if (!type) continue;
    normalized.push({
      id: typeof trigger.id === 'string' && trigger.id ? trigger.id : randomUUID(),
      type,
      enabled: Boolean(trigger.enabled),
      intervalMinutes: type === 'interval' ? safeIntervalMinutes(trigger.intervalMinutes) : undefined,
      debounceSeconds: type === 'on-change' ? safeDebounceSeconds(trigger.debounceSeconds) : undefined,
      mode: trigger.mode === 'analyze' ? 'analyze' : 'sync',
    });
  }

  return normalized.some((trigger) => trigger.type === 'manual')
    ? normalized
    : [{ id: randomUUID(), type: 'manual', enabled: true, mode: 'sync' }, ...normalized];
}

function normalizeTriggerType(type: FileSyncTriggerType | undefined): FileSyncTriggerType | null {
  return type === 'manual'
    || type === 'interval'
    || type === 'on-change'
    || type === 'on-startup'
    || type === 'path-available'
    || type === 'logoff'
    || type === 'schedule'
    ? type
    : null;
}

function normalizePatternList(patterns: string[] | undefined): string[] {
  return Array.from(new Set((patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean)));
}

function matchesFilters(relativePath: string, filters: FileSyncFilters): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (isWinUtilsTempPath(normalized)) return false;
  if (!matchesDirectoryFilters(normalized, filters)) return false;
  if (filters.includePatterns.length > 0 && !filters.includePatterns.some((pattern) => matchesPattern(normalized, pattern))) return false;
  return true;
}

function matchesDirectoryFilters(relativePath: string, filters: FileSyncFilters): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (filters.excludeHidden && normalized.split('/').some((segment) => segment.startsWith('.'))) return false;
  if (filters.excludeSystem && isSystemPath(normalized)) return false;
  return !filters.excludePatterns.some((pattern) => matchesPattern(normalized, pattern));
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern.endsWith('/**') && relativePath.toLowerCase() === normalizedPattern.slice(0, -3).toLowerCase()) {
    return true;
  }
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')}$`, 'i');
  return regex.test(relativePath) || regex.test(path.posix.basename(relativePath));
}

function isSystemPath(relativePath: string): boolean {
  return /(^|\/)(System Volume Information|\$RECYCLE\.BIN|pagefile\.sys|hiberfil\.sys|swapfile\.sys)(\/|$)/i.test(relativePath);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizePathKey(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isNestedPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isWinUtilsTempPath(relativePath: string): boolean {
  return /(^|\/)\.[^/]+\.winutils-[0-9a-f-]+\.tmp$/i.test(relativePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rename(sourcePath, targetPath);
}

function safeJoin(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }

  const root = path.resolve(rootPath);
  const targetPath = path.resolve(root, ...normalized.split('/').filter(Boolean));
  const relativeToRoot = path.relative(root, targetPath);
  if (relativeToRoot && (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot))) {
    throw new Error(`Resolved path escapes the sync root: ${relativePath}`);
  }

  return targetPath;
}

async function applyCopiedFileMetadata(targetPath: string, sourceStats: Stats): Promise<void> {
  await utimes(targetPath, sourceStats.atime, sourceStats.mtime);
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) <= MTIME_EQUAL_TOLERANCE_MS;
}

async function isDirectoryEmpty(directoryPath: string): Promise<boolean> {
  return (await readdir(directoryPath)).length === 0;
}

async function nextAvailablePath(targetPath: string): Promise<string> {
  if (!existsSync(targetPath)) return targetPath;
  const parsed = path.parse(targetPath);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.${index}${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to find an available conflict-copy path for ${targetPath}.`);
}

function conflictCopyName(relativePath: string, side: 'left' | 'right', timestamp: string): string {
  const parsed = path.parse(relativePath);
  const filename = `${parsed.name}.conflict-${side}-${timestamp}${parsed.ext}`;
  return parsed.dir ? path.join(parsed.dir, filename) : filename;
}

function snapshotEntry(entry: FileSyncEntryInfo): Pick<FileSyncEntryInfo, 'kind' | 'size' | 'modifiedAt' | 'hash'> {
  return {
    kind: entry.kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    hash: entry.hash,
  };
}

function automationTriggers(triggers: FileSyncTrigger[]): FileSyncTrigger[] {
  return triggers.filter((trigger) =>
    trigger.enabled
    && (trigger.type === 'interval' || trigger.type === 'on-change' || trigger.type === 'on-startup' || trigger.type === 'path-available'),
  );
}

function endpointsAvailable(job: FileSyncJob): boolean {
  return Boolean(job.leftPath && job.rightPath && existsSync(job.leftPath) && existsSync(job.rightPath));
}

function safeIntervalMinutes(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 1 ? Math.min(Math.round(Number(value)), 10_080) : DEFAULT_INTERVAL_MINUTES;
}

function safeDebounceSeconds(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 1 ? Math.min(Math.round(Number(value)), 300) : DEFAULT_CHANGE_DEBOUNCE_SECONDS;
}

function summarizeAutomationPreview(preview: FileSyncAnalyzeResult): string {
  if (preview.counts.errors > 0 || preview.counts.conflicts > 0) {
    return `Blocked: ${preview.counts.conflicts} conflict(s), ${preview.counts.errors} error(s).`;
  }

  const actionableCount = preview.counts.copyLeftToRight + preview.counts.copyRightToLeft + preview.counts.quarantine;
  return actionableCount === 0
    ? 'No file changes found.'
    : `Analyzed ${actionableCount} safe operation(s).`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'file-sync-job';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}
