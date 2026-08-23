import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  FileSyncAnalyzeResult,
  FileSyncApplyResult,
  FileSyncConflictPolicy,
  FileSyncEntryInfo,
  FileSyncItemKind,
  FileSyncJob,
  FileSyncJobInput,
  FileSyncMode,
  FileSyncPreviewRow,
  FileSyncPreviewStatus,
  FileSyncState,
  FileSyncTriggerType,
} from '../../shared/fileSync';

const modeLabels: Record<FileSyncMode, string> = {
  'left-to-right-update': '1-Way Update: Left to Right',
  'left-to-right-mirror': '1-Way Mirror: Left to Right',
  'right-to-left-update': '1-Way Update: Right to Left',
  'right-to-left-mirror': '1-Way Mirror: Right to Left',
  'two-way': 'Synchronize 2-Way',
};

const conflictLabels: Record<FileSyncConflictPolicy, string> = {
  manual: 'Do Not Copy',
  newer: 'Newer Wins',
  left: 'Left Wins',
  right: 'Right Wins',
  'keep-both': 'Keep Both',
};

type FilterListName = 'includePatterns' | 'excludePatterns';

interface FileSyncTreeNode {
  id: string;
  name: string;
  relativePath: string;
  kind: FileSyncItemKind;
  entry?: FileSyncEntryInfo;
  row?: FileSyncPreviewRow;
  status?: FileSyncPreviewStatus;
  children: FileSyncTreeNode[];
}

const mergeJobPatch = (job: FileSyncJob, patch: FileSyncJobInput): FileSyncJob => ({
  ...job,
  ...patch,
  filters: patch.filters ? { ...job.filters, ...patch.filters } : job.filters,
  options: patch.options ? { ...job.options, ...patch.options } : job.options,
  triggers: patch.triggers ?? job.triggers,
});

const buildAnalyzeSignature = (job: FileSyncJob): string => JSON.stringify({
  id: job.id,
  leftPath: job.leftPath,
  rightPath: job.rightPath,
  mode: job.mode,
  filters: job.filters,
  options: {
    compareMode: job.options.compareMode,
    conflictPolicy: job.options.conflictPolicy,
    createMissingFolders: job.options.createMissingFolders,
    detectMoves: job.options.detectMoves,
    symbolicLinks: job.options.symbolicLinks,
  },
});

export function FileSyncTab(): ReactElement {
  const [state, setState] = useState<FileSyncState | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileSyncAnalyzeResult | null>(null);
  const [lastApply, setLastApply] = useState<FileSyncApplyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoAnalyzing, setAutoAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const autoAnalyzeRequestIdRef = useRef(0);
  const lastAutoAnalyzeSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    void loadState(true);
    return window.winUtils.fileSync.onChanged(() => {
      void loadState(false);
    });
  }, []);

  const selectedJob = useMemo(() => state?.jobs.find((job) => job.id === selectedJobId) ?? state?.jobs[0] ?? null, [selectedJobId, state]);
  const selectedAutomation = useMemo(() => state?.automation.find((item) => item.jobId === selectedJob?.id) ?? null, [selectedJob?.id, state]);
  const autoAnalyzeSignature = useMemo(() => selectedJob ? buildAnalyzeSignature(selectedJob) : null, [selectedJob]);
  const hasBothFolders = Boolean(selectedJob?.leftPath.trim() && selectedJob?.rightPath.trim());
  const actionableCount = preview ? preview.counts.copyLeftToRight + preview.counts.copyRightToLeft + preview.counts.quarantine : 0;

  useEffect(() => {
    if (!selectedJob || !autoAnalyzeSignature || !hasBothFolders || busy === 'sync files') return;
    if (lastAutoAnalyzeSignatureRef.current === autoAnalyzeSignature) return;

    const requestId = autoAnalyzeRequestIdRef.current + 1;
    autoAnalyzeRequestIdRef.current = requestId;

    const timeoutId = window.setTimeout(() => {
      setAutoAnalyzing(true);
      window.winUtils.fileSync.analyze(selectedJob.id)
        .then((result) => {
          if (autoAnalyzeRequestIdRef.current !== requestId) return;
          setPreview(result);
          setLastApply(null);
          setError(null);
          lastAutoAnalyzeSignatureRef.current = autoAnalyzeSignature;
        })
        .catch((caughtError: unknown) => {
          if (autoAnalyzeRequestIdRef.current !== requestId) return;
          setPreview(null);
          setError(getErrorMessage(caughtError, 'Unable to auto-analyze file sync job.'));
        })
        .finally(() => {
          if (autoAnalyzeRequestIdRef.current === requestId) setAutoAnalyzing(false);
        });
    }, 650);

    return () => {
      window.clearTimeout(timeoutId);
      autoAnalyzeRequestIdRef.current += 1;
      setAutoAnalyzing(false);
    };
  }, [autoAnalyzeSignature, busy, hasBothFolders, selectedJob]);

  const loadState = async (showLoading = false): Promise<void> => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const nextState = await window.winUtils.fileSync.getState();
      setState(nextState);
      setSelectedJobId((currentId) => currentId ?? nextState.jobs[0]?.id ?? null);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, 'Unable to load file sync jobs.'));
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (label: string, action: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (success) setMessage(success);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, `Unable to ${label}.`));
    } finally {
      setBusy(null);
    }
  };

  const createJob = async (): Promise<void> => {
    await runAction('create file sync job', async () => {
      const nextState = await window.winUtils.fileSync.createJob();
      setState(nextState);
      setSelectedJobId(nextState.jobs[0]?.id ?? null);
      setPreview(null);
      setLastApply(null);
    }, 'File sync job created.');
  };

  const updateJob = async (patch: FileSyncJobInput, preservePreview = false): Promise<void> => {
    if (!selectedJob) return;
    const previousState = state;
    const optimisticJob = mergeJobPatch(selectedJob, patch);

    setError(null);
    setState((currentState) => currentState ? {
      ...currentState,
      jobs: currentState.jobs.map((job) => (job.id === selectedJob.id ? optimisticJob : job)),
    } : currentState);
    if (!preservePreview) {
      setPreview(null);
      setLastApply(null);
    }

    try {
      const nextState = await window.winUtils.fileSync.updateJob(selectedJob.id, patch);
      setState(nextState);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, 'Unable to update file sync job.'));
      setState(previousState);
    }
  };

  const deleteJob = async (): Promise<void> => {
    if (!selectedJob) return;
    await runAction('delete file sync job', async () => {
      const nextState = await window.winUtils.fileSync.deleteJob(selectedJob.id);
      setState(nextState);
      setSelectedJobId(nextState.jobs[0]?.id ?? null);
      setPreview(null);
      setLastApply(null);
    }, 'File sync job removed.');
  };

  const pickFolder = async (side: 'leftPath' | 'rightPath'): Promise<void> => {
    if (!selectedJob) return;
    const folder = await window.winUtils.fileSync.pickFolder();
    if (folder) await updateJob({ [side]: folder });
  };

  const analyze = async (): Promise<void> => {
    if (!selectedJob) return;
    if (!hasBothFolders) {
      setError('Choose both left and right folders before analyzing.');
      return;
    }
    await runAction('analyze file sync job', async () => {
      const result = await window.winUtils.fileSync.analyze(selectedJob.id);
      setPreview(result);
      setLastApply(null);
      if (autoAnalyzeSignature) lastAutoAnalyzeSignatureRef.current = autoAnalyzeSignature;
    }, 'Analysis complete. Review the preview before syncing.');
  };

  const apply = async (): Promise<void> => {
    if (!selectedJob || !hasBothFolders) {
      setError('Choose both left and right folders before syncing.');
      return;
    }
    await runAction('sync files', async () => {
      const result = await window.winUtils.fileSync.apply(selectedJob.id);
      setLastApply(result);
      setPreview(await window.winUtils.fileSync.analyze(selectedJob.id));
      if (autoAnalyzeSignature) lastAutoAnalyzeSignatureRef.current = autoAnalyzeSignature;
      setState(await window.winUtils.fileSync.getState());
    }, 'Sync finished. Replaced/deleted files were moved to quarantine.');
  };

  const addFilterPattern = async (listName: FilterListName, relativePath: string, kind: FileSyncItemKind): Promise<void> => {
    if (!selectedJob) return;
    const pattern = patternForEntry(relativePath, kind);
    const currentPatterns = selectedJob.filters[listName];
    if (currentPatterns.some((item) => item.toLowerCase() === pattern.toLowerCase())) {
      setMessage(`${pattern} is already in ${listName === 'excludePatterns' ? 'excludes' : 'includes'}.`);
      return;
    }

    await updateJob({ filters: { [listName]: [...currentPatterns, pattern] } }, true);
    setMessage(`${pattern} added to ${listName === 'excludePatterns' ? 'blacklist/excludes' : 'whitelist/includes'}. The tree will refresh automatically.`);
  };

  if (loading) return <div className="empty-state">Loading file sync jobs...</div>;

  return (
    <div className="file-sync-layout module-shell module-shell--file-sync">
      <aside className="file-sync-jobs-panel">
        <div className="renamer-panel-header">
          <div>
            <p className="section-kicker">Jobs</p>
            <h2>File Sync</h2>
          </div>
          <div className="file-sync-job-actions">
            <button className="micro-button" type="button" onClick={() => void createJob()} disabled={busy !== null} title="Create a new local folder sync job.">
              New
            </button>
            <button className="micro-button micro-button--danger" type="button" onClick={() => void deleteJob()} disabled={busy !== null || !selectedJob} title="Delete the selected file sync job and its saved automation settings.">
              Delete
            </button>
          </div>
        </div>

        <div className="file-sync-job-list">
          {state?.jobs.map((job) => (
            <button
              className={`file-sync-job ${selectedJob?.id === job.id ? 'file-sync-job--active' : ''}`}
              key={job.id}
              type="button"
              onClick={() => { setSelectedJobId(job.id); setPreview(null); setLastApply(null); }}
              title={`${job.leftPath || 'Left not set'} -> ${job.rightPath || 'Right not set'}`}
            >
              <strong>{job.name}</strong>
              <span>{modeLabels[job.mode]}</span>
              <small>{job.lastRunStatus ? `Last run: ${job.lastRunStatus}` : 'Not run yet'}</small>
            </button>
          ))}
          {state?.jobs.length === 0 ? <div className="empty-state">No sync jobs yet.</div> : null}
        </div>
      </aside>

      <section className="file-sync-main">
        {error ? <div className="error-banner">{error}</div> : null}
        {message ? <div className="success-banner">{message}</div> : null}

        {!selectedJob ? (
          <div className="empty-state">Create a sync job to choose folders and analyze changes.</div>
        ) : (
          <>
            <div className="file-sync-toolbar">
              <div>
                <p className="section-kicker">Job workspace</p>
                <h2>{selectedJob.name}</h2>
                <p>Auto-analyze first, sync second. Local folder sync only with verified temp copies and quarantine instead of hard deletes.</p>
                {selectedAutomation ? (
                  <p className="file-sync-automation-line">
                    Automation: {formatAutomation(selectedAutomation)}
                  </p>
                ) : null}
              </div>
              <div className="renamer-batch-actions">
                <button className="ghost-button" type="button" onClick={() => void analyze()} disabled={busy !== null || autoAnalyzing || !hasBothFolders} title="Choose both folders before refreshing the no-write folder comparison.">
                  {autoAnalyzing ? 'Analyzing...' : 'Analyze now'}
                </button>
                <button className="toggle-button" type="button" onClick={() => void apply()} disabled={busy !== null || autoAnalyzing || !preview || preview.counts.conflicts > 0 || preview.counts.errors > 0 || actionableCount === 0} title="Apply the previewed safe sync operations.">
                  {busy === 'sync files' ? 'Syncing...' : 'Sync'}
                </button>
              </div>
            </div>

            <PreviewPanel
              job={selectedJob}
              preview={preview}
              lastApply={lastApply}
              autoAnalyzing={autoAnalyzing}
              onAddPattern={addFilterPattern}
              onChangePath={(side, value) => updateJob(side === 'leftPath' ? { leftPath: value } : { rightPath: value })}
              onBrowse={pickFolder}
            />

            <div className="file-sync-config-grid">
              <section className="file-sync-card">
                <p className="section-kicker">Basics</p>
                <h3>General</h3>
                <label className="macro-label">Job name</label>
                <input className="macro-input" value={selectedJob.name} onChange={(event) => void updateJob({ name: event.target.value })} />
                <label className="macro-label">Job type</label>
                <select className="macro-select" value={selectedJob.mode} onChange={(event) => void updateJob({ mode: event.target.value as FileSyncMode })}>
                  {Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <label title="Create a missing endpoint folder when a sync operation needs it.">
                  <input type="checkbox" checked={selectedJob.options.createMissingFolders} onChange={(event) => void updateJob({ options: { createMissingFolders: event.target.checked } })} />
                  Create left/right folders if they are not found
                </label>
                <label title="Always move deleted/replaced files into the WinUtils quarantine folder instead of hard-deleting.">
                  <input type="checkbox" checked={selectedJob.options.quarantineDeletes} onChange={(event) => void updateJob({ options: { quarantineDeletes: event.target.checked } })} />
                  Save deleted/replaced files in quarantine
                </label>
                <label title="Keep replaced versions in quarantine so they can be recovered after a sync.">
                  <input type="checkbox" checked={selectedJob.options.keepVersions} onChange={(event) => void updateJob({ options: { keepVersions: event.target.checked } })} />
                  Keep replaced versions
                </label>
              </section>

              <section className="file-sync-card">
                <p className="section-kicker">Inclusion rules</p>
                <h3>Filters</h3>
                <label className="macro-label">Exclude patterns</label>
                <textarea className="macro-input file-sync-textarea" value={selectedJob.filters.excludePatterns.join('\n')} onChange={(event) => void updateJob({ filters: { excludePatterns: splitPatterns(event.target.value) } })} placeholder="node_modules/**&#10;*.tmp" />
                <label className="macro-label">Include patterns</label>
                <textarea className="macro-input file-sync-textarea" value={selectedJob.filters.includePatterns.join('\n')} onChange={(event) => void updateJob({ filters: { includePatterns: splitPatterns(event.target.value) } })} placeholder="Leave empty to include everything" />
                <label className="macro-label">Max file size (MB)</label>
                <input className="macro-input" type="number" min="0" step="1" value={maxSizeToMegabytes(selectedJob.filters.maxFileSizeBytes)} onChange={(event) => void updateJob({ filters: { maxFileSizeBytes: megabytesToBytes(event.target.value) } })} placeholder="No limit" />
                <label><input type="checkbox" checked={selectedJob.filters.excludeHidden} onChange={(event) => void updateJob({ filters: { excludeHidden: event.target.checked } })} />Exclude hidden files and folders</label>
                <label><input type="checkbox" checked={selectedJob.filters.excludeSystem} onChange={(event) => void updateJob({ filters: { excludeSystem: event.target.checked } })} />Exclude system files and folders</label>
                <label><input type="checkbox" checked={selectedJob.filters.excludeEmptyFolders} onChange={(event) => void updateJob({ filters: { excludeEmptyFolders: event.target.checked } })} />Exclude empty folders</label>
              </section>

              <section className="file-sync-card">
                <p className="section-kicker">Automation</p>
                <h3>Auto</h3>
                <p className="inline-note">Auto-sync runs only after this job has completed one manual Sync successfully. It skips conflicts/errors and never runs two copies of the same job at once.</p>
                <label><input type="checkbox" checked={isTriggerEnabled(selectedJob, 'on-change')} onChange={(event) => void updateJob({ triggers: setTriggerEnabled(selectedJob, 'on-change', event.target.checked) })} />On file change</label>
                <label className="macro-label">Change debounce (seconds)</label>
                <input className="macro-input" type="number" min="1" max="300" value={getTrigger(selectedJob, 'on-change')?.debounceSeconds ?? 8} onChange={(event) => void updateJob({ triggers: updateTrigger(selectedJob, 'on-change', { debounceSeconds: Number(event.target.value) }) })} />
                <label><input type="checkbox" checked={isTriggerEnabled(selectedJob, 'path-available')} onChange={(event) => void updateJob({ triggers: setTriggerEnabled(selectedJob, 'path-available', event.target.checked) })} />When both folders become available</label>
                <label><input type="checkbox" checked={isTriggerEnabled(selectedJob, 'on-startup')} onChange={(event) => void updateJob({ triggers: setTriggerEnabled(selectedJob, 'on-startup', event.target.checked) })} />On WinUtils start</label>
                <label><input type="checkbox" checked={isTriggerEnabled(selectedJob, 'interval')} onChange={(event) => void updateJob({ triggers: setTriggerEnabled(selectedJob, 'interval', event.target.checked) })} />Periodically</label>
                <label className="macro-label">Interval (minutes)</label>
                <input className="macro-input" type="number" min="1" max="10080" value={getTrigger(selectedJob, 'interval')?.intervalMinutes ?? 15} onChange={(event) => void updateJob({ triggers: updateTrigger(selectedJob, 'interval', { intervalMinutes: Number(event.target.value) }) })} />
              </section>

              <section className="file-sync-card">
                <p className="section-kicker">Conflict behavior</p>
                <h3>Advanced</h3>
                <label className="macro-label">Compare mode</label>
                <select className="macro-select" value={selectedJob.options.compareMode} onChange={(event) => void updateJob({ options: { compareMode: event.target.value as 'size-time' | 'hash' } })}>
                  <option value="size-time">Size + modified time</option>
                  <option value="hash">Checksum file bodies</option>
                </select>
                <label className="macro-label">Two-way conflict policy</label>
                <select className="macro-select" value={selectedJob.options.conflictPolicy} onChange={(event) => void updateJob({ options: { conflictPolicy: event.target.value as FileSyncConflictPolicy } })}>
                  {Object.entries(conflictLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
                <label><input type="checkbox" checked={selectedJob.options.verifyCopies} onChange={(event) => void updateJob({ options: { verifyCopies: event.target.checked } })} />Verify checksum after copy</label>
                <label title="Move and rename detection needs a dedicated safe apply path before it can be enabled."><input type="checkbox" checked={selectedJob.options.detectMoves} disabled readOnly />Detect moves and renames (planned)</label>
                <label className="macro-label">Symbolic links and junctions</label>
                <select className="macro-select" value={selectedJob.options.symbolicLinks} onChange={(event) => void updateJob({ options: { symbolicLinks: event.target.value as 'ignore' | 'copy-as-is' | 'drill-down' } })}>
                  <option value="ignore">Ignore</option>
                  <option value="copy-as-is" disabled>Copy as is (planned)</option>
                  <option value="drill-down" disabled>Drill down (planned)</option>
                </select>
              </section>
            </div>

            <section className="file-sync-history">
              <div className="file-sync-history-header">
                <div>
                  <p className="section-kicker">Audit trail</p>
                  <h3>Recent runs</h3>
                </div>
                <span className="inline-note">{state?.recentRuns.filter((run) => run.jobId === selectedJob.id).length ?? 0} recorded</span>
              </div>
              <FileSyncRunHistory runs={(state?.recentRuns ?? []).filter((run) => run.jobId === selectedJob.id)} />
            </section>
          </>
        )}
      </section>
    </div>
  );
}

function PreviewPanel({ job, preview, lastApply, autoAnalyzing, onAddPattern, onChangePath, onBrowse }: {
  job: FileSyncJob;
  preview: FileSyncAnalyzeResult | null;
  lastApply: FileSyncApplyResult | null;
  autoAnalyzing: boolean;
  onAddPattern: (listName: FilterListName, relativePath: string, kind: FileSyncItemKind) => Promise<void>;
  onChangePath: (side: 'leftPath' | 'rightPath', value: string) => Promise<void>;
  onBrowse: (side: 'leftPath' | 'rightPath') => Promise<void>;
}): ReactElement {
  const leftTree = preview ? buildTree(preview.rows, 'left') : [];
  const rightTree = preview ? buildTree(preview.rows, 'right') : [];
  const changedRows = preview ? preview.rows.filter((row) => row.status !== 'unchanged') : [];
  const actionRows = changedRows.slice(0, 160);

  return (
    <section className="file-sync-preview">
      {preview ? (
        <div className="renamer-stat-grid">
          <StatPill label="Total" value={preview.counts.total} />
          <StatPill label="Ready" value={preview.counts.ready} />
          <StatPill label="Warnings" value={preview.counts.warnings} tone="warning" />
          <StatPill label="Conflicts" value={preview.counts.conflicts} tone="danger" />
          <StatPill label="Errors" value={preview.counts.errors} tone="danger" />
          <StatPill label="Quarantine" value={preview.counts.quarantine} tone="warning" />
        </div>
      ) : (
        <p className="inline-note">{autoAnalyzing ? 'Analyzing folders...' : 'Choose left and right folders here. The side-by-side tree loads automatically.'}</p>
      )}
      {lastApply ? <div className="success-banner">Applied {lastApply.appliedCount} operation(s), {lastApply.failedCount} failed.</div> : null}
      <div className="file-sync-compare-shell">
        <TreePanel
          title="Left"
          rootPath={job.leftPath}
          side="leftPath"
          nodes={leftTree}
          hasPreview={preview !== null}
          onChangePath={onChangePath}
          onBrowse={onBrowse}
          onAddPattern={onAddPattern}
        />
        <div className="file-sync-action-rail">
          <div className="file-sync-action-rail__head">Actions</div>
          {!preview ? (
            <div className="file-sync-action-empty">{autoAnalyzing ? 'Analyzing...' : 'Planned copies, updates, deletes, and conflicts appear here automatically.'}</div>
          ) : actionRows.length === 0 ? (
            <div className="file-sync-action-empty">No file changes.</div>
          ) : actionRows.map((row) => (
            <div className={`file-sync-action-chip file-sync-action-chip--${row.status}`} key={row.id} title={row.reason}>
              <span>{formatDirection(row.action)}</span>
              <code>{row.relativePath}</code>
            </div>
          ))}
          {changedRows.length > actionRows.length ? <div className="file-sync-action-empty">Showing first {actionRows.length} changed rows.</div> : null}
        </div>
        <TreePanel
          title="Right"
          rootPath={job.rightPath}
          side="rightPath"
          nodes={rightTree}
          hasPreview={preview !== null}
          onChangePath={onChangePath}
          onBrowse={onBrowse}
          onAddPattern={onAddPattern}
        />
      </div>
      {preview ? (
        <div className="file-sync-table">
          <div className="file-sync-row file-sync-row--head">
            <span>Action</span>
            <span>Path</span>
            <span>Left</span>
            <span>Right</span>
            <span>Reason</span>
          </div>
          {preview.rows.slice(0, 240).map((row) => <PreviewRow row={row} key={row.id} />)}
          {preview.rows.length > 240 ? <div className="renamer-table-footer">Showing first 240 of {preview.rows.length} rows.</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function FileSyncRunHistory({ runs }: { runs: FileSyncState['recentRuns'] }): ReactElement {
  if (runs.length === 0) {
    return <div className="empty-state empty-state--compact">No completed runs for this job yet.</div>;
  }

  return (
    <div className="file-sync-history-list">
      {runs.slice(0, 8).map((run) => (
        <article className="file-sync-history-row" key={run.id}>
          <div>
            <strong>{formatRunStatus(run.status)}</strong>
            <span>{formatRunTrigger(run.trigger)} · {formatRunDate(run.finishedAt)}</span>
          </div>
          <div className="file-sync-history-counts">
            <span>{run.appliedCount} applied</span>
            <span>{run.failedCount} failed</span>
            <span>{run.analyzed.total} compared</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function formatRunStatus(status: FileSyncState['recentRuns'][number]['status']): string {
  if (status === 'applied') return 'Sync completed';
  if (status === 'partial') return 'Sync partially completed';
  if (status === 'failed') return 'Sync failed';
  return 'Analysis completed';
}

function formatRunTrigger(trigger: FileSyncState['recentRuns'][number]['trigger']): string {
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'on-change') return 'File change';
  if (trigger === 'on-startup') return 'App startup';
  if (trigger === 'path-available') return 'Path available';
  if (trigger === 'interval') return 'Interval';
  if (trigger === 'schedule') return 'Schedule';
  return 'Logoff';
}

function formatRunDate(value: string): string {
  return new Date(value).toLocaleString();
}

function TreePanel({ title, rootPath, side, nodes, hasPreview, onChangePath, onBrowse, onAddPattern }: {
  title: string;
  rootPath: string;
  side: 'leftPath' | 'rightPath';
  nodes: FileSyncTreeNode[];
  hasPreview: boolean;
  onChangePath: (side: 'leftPath' | 'rightPath', value: string) => Promise<void>;
  onBrowse: (side: 'leftPath' | 'rightPath') => Promise<void>;
  onAddPattern: (listName: FilterListName, relativePath: string, kind: FileSyncItemKind) => Promise<void>;
}): ReactElement {
  return (
    <div className="file-sync-tree-panel">
      <div className="file-sync-tree-header">
        <div className="file-sync-tree-title">
          <strong>{title}</strong>
          <span>{side === 'leftPath' ? 'Left folder' : 'Right folder'}</span>
        </div>
        <div className="file-sync-tree-picker">
          <input className="macro-input" value={rootPath} onChange={(event) => void onChangePath(side, event.target.value)} placeholder={`Choose ${side === 'leftPath' ? 'left' : 'right'} folder...`} />
          <button className="ghost-button ghost-button--sm" type="button" onClick={() => void onBrowse(side)}>Browse</button>
        </div>
      </div>
      <div className="file-sync-tree">
        {nodes.length === 0 ? (
          <div className="file-sync-tree-empty">{rootPath ? (hasPreview ? 'No files on this side.' : 'Run Analyze to load this folder tree.') : 'Choose a folder for this side.'}</div>
        ) : nodes.map((node) => (
          <TreeNode node={node} depth={0} key={node.id} onAddPattern={onAddPattern} />
        ))}
      </div>
    </div>
  );
}

function TreeNode({ node, depth, onAddPattern }: {
  node: FileSyncTreeNode;
  depth: number;
  onAddPattern: (listName: FilterListName, relativePath: string, kind: FileSyncItemKind) => Promise<void>;
}): ReactElement {
  const canFilter = node.relativePath.length > 0;
  const statusClass = node.status ? ` file-sync-tree-item--${node.status}` : '';

  return (
    <>
      <div className={`file-sync-tree-item${statusClass}`} style={{ paddingLeft: `${10 + depth * 18}px` }} title={node.row?.reason ?? node.relativePath}>
        <span className="file-sync-tree-icon">{node.kind === 'directory' ? 'Folder' : 'File'}</span>
        <span className="file-sync-tree-name">{node.name}</span>
        {node.entry ? <span className="file-sync-tree-meta">{node.kind === 'directory' ? 'Folder' : formatBytes(node.entry.size)}</span> : null}
        {canFilter ? (
          <span className="file-sync-tree-actions">
            <button type="button" onClick={() => void onAddPattern('excludePatterns', node.relativePath, node.kind)} title="Add this path to the exclude/blacklist filters.">
              Exclude
            </button>
            <button type="button" onClick={() => void onAddPattern('includePatterns', node.relativePath, node.kind)} title="Add this path to the include/whitelist filters.">
              Include
            </button>
          </span>
        ) : null}
      </div>
      {node.children.map((child) => (
        <TreeNode node={child} depth={depth + 1} key={child.id} onAddPattern={onAddPattern} />
      ))}
    </>
  );
}

function PreviewRow({ row }: { row: FileSyncPreviewRow }): ReactElement {
  return (
    <div className={`file-sync-row file-sync-row--${row.status}`}>
      <span>{formatAction(row.action)}</span>
      <code title={row.relativePath}>{row.relativePath}</code>
      <span>{row.left ? formatEntryInfo(row.left) : '-'}</span>
      <span>{row.right ? formatEntryInfo(row.right) : '-'}</span>
      <span>{row.reason}</span>
    </div>
  );
}

function buildTree(rows: FileSyncPreviewRow[], side: 'left' | 'right'): FileSyncTreeNode[] {
  const root: FileSyncTreeNode[] = [];

  for (const row of rows) {
    const entry = side === 'left' ? row.left : row.right;
    if (!entry) continue;

    const segments = row.relativePath.split('/').filter(Boolean);
    insertTreeNode(root, side, segments, row, entry);
  }

  return sortTree(root);
}

function insertTreeNode(nodes: FileSyncTreeNode[], side: 'left' | 'right', segments: string[], row: FileSyncPreviewRow, entry: FileSyncEntryInfo): void {
  let currentLevel = nodes;
  let currentPath = '';

  segments.forEach((segment, index) => {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const isLeaf = index === segments.length - 1;
    let node = currentLevel.find((item) => item.name === segment);
    if (!node) {
      node = {
        id: `${side}:${currentPath}`,
        name: segment,
        relativePath: currentPath,
        kind: isLeaf ? entry.kind : 'directory',
        children: [],
      };
      currentLevel.push(node);
    }

    if (isLeaf) {
      node.kind = entry.kind;
      node.entry = entry;
      node.row = row;
      node.status = row.status;
    }

    currentLevel = node.children;
  });
}

function sortTree(nodes: FileSyncTreeNode[]): FileSyncTreeNode[] {
  return nodes
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({ ...node, children: sortTree(node.children) }));
}

function patternForEntry(relativePath: string, kind: FileSyncItemKind): string {
  return kind === 'directory' ? `${relativePath}/**` : relativePath;
}

function StatPill({ label, value, tone = 'info' }: { label: string; value: number; tone?: 'info' | 'warning' | 'danger' }): ReactElement {
  return (
    <div className={`renamer-stat renamer-stat--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getTrigger(job: FileSyncJob, type: FileSyncTriggerType): FileSyncJob['triggers'][number] | undefined {
  return job.triggers.find((trigger) => trigger.type === type);
}

function isTriggerEnabled(job: FileSyncJob, type: FileSyncTriggerType): boolean {
  return Boolean(getTrigger(job, type)?.enabled);
}

function setTriggerEnabled(job: FileSyncJob, type: FileSyncTriggerType, enabled: boolean): FileSyncJob['triggers'] {
  return updateTrigger(job, type, { enabled });
}

function updateTrigger(job: FileSyncJob, type: FileSyncTriggerType, patch: Partial<FileSyncJob['triggers'][number]>): FileSyncJob['triggers'] {
  const existing = job.triggers.find((trigger) => trigger.type === type);
  if (existing) {
    return job.triggers.map((trigger) => trigger.type === type ? { ...trigger, ...patch, mode: patch.mode ?? trigger.mode ?? 'sync' } : trigger);
  }

  return [
    ...job.triggers,
    {
      id: crypto.randomUUID(),
      type,
      enabled: patch.enabled ?? false,
      intervalMinutes: type === 'interval' ? patch.intervalMinutes ?? 15 : undefined,
      debounceSeconds: type === 'on-change' ? patch.debounceSeconds ?? 8 : undefined,
      mode: patch.mode ?? 'sync',
    },
  ];
}

function splitPatterns(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function maxSizeToMegabytes(bytes: number | undefined): string {
  return bytes ? String(Math.round(bytes / 1024 / 1024)) : '';
}

function megabytesToBytes(value: string): number | undefined {
  const megabytes = Number(value);
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : undefined;
}

function formatAutomation(automation: FileSyncState['automation'][number]): string {
  if (automation.running) return `running via ${automation.lastTrigger ?? 'trigger'}`;
  const triggerText = automation.enabledTriggers.length > 0 ? automation.enabledTriggers.join(', ') : 'off';
  const statusText = automation.lastStatus ? `, ${automation.lastStatus}` : '';
  const nextText = automation.nextRunAt ? `, next ${new Date(automation.nextRunAt).toLocaleTimeString()}` : '';
  const messageText = automation.lastMessage ? ` - ${automation.lastMessage}` : '';
  return `${triggerText}${statusText}${nextText}${messageText}`;
}

function formatAction(action: string): string {
  return action.replace(/-/g, ' ');
}

function formatDirection(action: string): string {
  if (action.endsWith('left-to-right') || action === 'create-directory-right') return 'Left -> Right';
  if (action.endsWith('right-to-left') || action === 'create-directory-left') return 'Right -> Left';
  if (action.endsWith('left') || action === 'quarantine-directory-left') return 'Quarantine Left';
  if (action.endsWith('right') || action === 'quarantine-directory-right') return 'Quarantine Right';
  if (action === 'keep-both') return 'Keep Both';
  if (action === 'conflict') return 'Conflict';
  return formatAction(action);
}

function formatEntryInfo(entry: FileSyncEntryInfo): string {
  if (entry.kind === 'directory') return `Folder, ${new Date(entry.modifiedAt).toLocaleString()}`;
  return `${formatBytes(entry.size)}, ${new Date(entry.modifiedAt).toLocaleString()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getErrorMessage(caughtError: unknown, fallback: string): string {
  if (!(caughtError instanceof Error)) return typeof caughtError === 'string' && caughtError.trim() ? caughtError : fallback;
  return caughtError.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}
