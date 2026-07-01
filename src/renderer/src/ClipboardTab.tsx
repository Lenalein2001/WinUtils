import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ClipboardEntry, ClipboardFilter, ClipboardSettings, ClipboardState } from '../../shared/clipboard';

const filterOptions: Array<{ value: ClipboardFilter; label: string; title: string }> = [
  { value: 'all', label: 'All', title: 'Show every saved clipboard item.' },
  { value: 'pinned', label: 'Pinned', title: 'Show only clipboard items pinned for long-term reuse.' },
  { value: 'url', label: 'URLs', title: 'Show copied links and web addresses.' },
  { value: 'email', label: 'Emails', title: 'Show copied email addresses.' },
  { value: 'code', label: 'Code', title: 'Show multi-line snippets that look like source code.' },
  { value: 'file-path', label: 'Files', title: 'Show copied file paths and Explorer selections.' },
  { value: 'image', label: 'Images', title: 'Show copied images and OCR text extracted from them.' },
];

const categoryLabels: Record<string, string> = {
  'plain-text': 'Text',
  url: 'URL',
  email: 'Email',
  code: 'Code',
  'file-path': 'File Path',
  image: 'Image',
};

export function ClipboardTab(): ReactElement {
  const [state, setState] = useState<ClipboardState | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ClipboardFilter>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState({ maxEntries: '350', retentionDays: '0' });

  const entries = state?.entries ?? [];
  const visibleSummary = useMemo(() => {
    if (!state) return 'No clipboard data loaded yet.';
    if (state.total === 0) return 'Clipboard history is empty.';
    if (entries.length === state.total) return `${entries.length} saved items.`;
    return `${entries.length} of ${state.total} saved items.`;
  }, [entries.length, state]);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void loadState(cancelled);
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search, filter]);

  useEffect(() => {
    const unsubscribe = window.winUtils.clipboard.onChanged(() => {
      void loadState(false, false);
    });

    return unsubscribe;
  }, [search, filter]);

  useEffect(() => {
    if (!state) return;
    setRetentionDraft({
      maxEntries: String(state.settings.maxEntries),
      retentionDays: String(state.settings.retentionDays),
    });
  }, [state?.settings.maxEntries, state?.settings.retentionDays]);

  const loadState = async (cancelled = false, showSpinner = true): Promise<void> => {
    if (showSpinner) setLoading(true);
    setError(null);

    try {
      const nextState = await window.winUtils.clipboard.getState({ search, filter, limit: 160 });
      if (!cancelled) setState(nextState);
    } catch (caughtError) {
      if (!cancelled) setError(getErrorMessage(caughtError, 'Unable to load clipboard history.'));
    } finally {
      if (!cancelled && showSpinner) setLoading(false);
    }
  };

  const runAction = async (label: string, action: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);

    try {
      await action();
      if (success) setMessage(success);
      await loadState(false, false);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, `Unable to ${label}.`));
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async (entry: ClipboardEntry): Promise<void> => {
    await runAction('copy item', () => window.winUtils.clipboard.copy(entry.id).then(() => undefined), 'Copied back to the clipboard.');
  };

  const handlePinned = async (entry: ClipboardEntry): Promise<void> => {
    await runAction(
      entry.pinned ? 'unpin item' : 'pin item',
      () => window.winUtils.clipboard.setPinned(entry.id, !entry.pinned).then(() => undefined),
      entry.pinned ? 'Clipboard item unpinned.' : 'Clipboard item pinned.',
    );
  };

  const handleDelete = async (entry: ClipboardEntry): Promise<void> => {
    await runAction('delete item', () => window.winUtils.clipboard.delete(entry.id).then(() => undefined), 'Clipboard item deleted.');
  };

  const handleClear = async (mode: 'all' | 'unpinned'): Promise<void> => {
    const label = mode === 'all' ? 'clear all items' : 'clear unpinned items';
    await runAction(label, () => window.winUtils.clipboard.clear(mode).then(() => undefined), mode === 'all' ? 'Clipboard history cleared.' : 'Unpinned clipboard history cleared.');
  };

  const updateRetention = async (patch: Partial<Pick<ClipboardSettings, 'retentionDays' | 'maxEntries'>>): Promise<void> => {
    const current = state?.settings;
    if (!current) return;
    await runAction(
      'update retention',
      () => window.winUtils.clipboard.setRetention({
        retentionDays: patch.retentionDays ?? current.retentionDays,
        maxEntries: patch.maxEntries ?? current.maxEntries,
      }).then(() => undefined),
      'Clipboard retention updated.',
    );
  };

  const applyRetentionDraft = async (): Promise<void> => {
    await updateRetention({
      maxEntries: Number(retentionDraft.maxEntries),
      retentionDays: Number(retentionDraft.retentionDays),
    });
  };

  const registeredHotkeys = state?.registeredQuickAccessHotkeys?.length
    ? state.registeredQuickAccessHotkeys.map(formatHotkey)
    : [formatHotkey(state?.settings.quickAccessHotkey ?? 'Ctrl+Alt+V')];
  const hotkeyLabel = registeredHotkeys.join(' / ');
  const hotkeyTitle = state?.quickAccessRegistered
    ? `Press ${hotkeyLabel} anywhere in Windows to open WinUtils to Clipboard Manager.`
    : state?.quickAccessRegistrationError ?? 'The clipboard quick-access hotkey could not be registered.';
  const hotkeyDetail = state?.lastQuickAccessAt
    ? `Last used ${new Date(state.lastQuickAccessAt).toLocaleTimeString()}`
    : state?.quickAccessRegistered ? 'Ready' : 'Blocked';

  return (
    <div className="clipboard-layout">
      <div className="clipboard-topbar">
        <div>
          <p className="section-kicker">Clipboard Manager</p>
          <h2>Searchable clipboard history</h2>
          <p className="clipboard-subtitle">Text, images, file paths, pins, smart categories, and OCR text stay local on this PC.</p>
        </div>
        <div className="clipboard-toolbar">
          <button className="ghost-button" type="button" onClick={() => void runAction('capture clipboard', () => window.winUtils.clipboard.captureNow().then(() => undefined), 'Current clipboard captured.')} disabled={busy !== null} title="Immediately read the current Windows clipboard instead of waiting for the next automatic scan.">
            Capture Now
          </button>
          <button className="ghost-button" type="button" onClick={() => void loadState(false)} disabled={loading || busy !== null} title="Reload the stored clipboard history from disk.">
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {message ? <div className="success-banner">{message}</div> : null}

      <div className="clipboard-stats">
        <ClipboardStat label="Saved" value={state?.total ?? 0} title="Total clipboard items stored locally by WinUtils." />
        <ClipboardStat label="Pinned" value={state?.pinnedCount ?? 0} title="Items protected from unpinned history cleanup." />
        <ClipboardStat label="Text" value={state?.textCount ?? 0} title="Text clipboard entries." />
        <ClipboardStat label="Images" value={state?.imageCount ?? 0} title="Image clipboard entries with thumbnails and OCR status." />
        <ClipboardStat label="Files" value={state?.fileCount ?? 0} title="Explorer selections or copied file path lists." />
        <div className={`clipboard-stat ${state?.quickAccessRegistered ? '' : 'clipboard-stat--warning'}`} title={hotkeyTitle}>
          <span>Hotkey</span>
          <strong>{hotkeyLabel}</strong>
          <small>{hotkeyDetail}</small>
        </div>
      </div>

      <div className="clipboard-controls">
        <label className="clipboard-search">
          <span>Search</span>
          <input
            className="macro-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find text, paths, links, OCR results..."
            title="Search saved clipboard text, OCR text, file paths, previews, and category labels."
          />
        </label>
        <div className="clipboard-filter-row" aria-label="Clipboard filters">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              className={`micro-button clipboard-filter-button ${filter === option.value ? 'micro-button--active' : ''}`}
              type="button"
              onClick={() => setFilter(option.value)}
              title={option.title}
              aria-pressed={filter === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button className="micro-button clipboard-test-hotkey" type="button" disabled={busy !== null} onClick={() => void runAction('test hotkey', () => window.winUtils.clipboard.openQuickAccess().then(() => undefined), 'Quick access action fired.')} title="Run the same open action used by the global clipboard hotkey.">
          Test Hotkey
        </button>
      </div>

      <div className="clipboard-settings-strip">
        <label title="When enabled, WinUtils watches the Windows clipboard while the app is running or hidden in the tray.">
          <input
            type="checkbox"
            checked={state?.settings.monitoring ?? true}
            onChange={(event) => void runAction('update monitoring', () => window.winUtils.clipboard.setMonitoring(event.target.checked).then(() => undefined), event.target.checked ? 'Clipboard monitoring enabled.' : 'Clipboard monitoring paused.')}
            disabled={busy !== null}
          />
          <span>Monitor clipboard</span>
        </label>
        <label title="Store copied images as local PNG files with lightweight thumbnails in history.">
          <input
            type="checkbox"
            checked={state?.settings.captureImages ?? true}
            onChange={(event) => void runAction('update image capture', () => window.winUtils.clipboard.setCaptureImages(event.target.checked).then(() => undefined), event.target.checked ? 'Image capture enabled.' : 'Image capture disabled.')}
            disabled={busy !== null}
          />
          <span>Capture images</span>
        </label>
        <label title="Use Windows built-in OCR to extract searchable text from copied images when possible.">
          <input
            type="checkbox"
            checked={state?.settings.imageOcr ?? true}
            onChange={(event) => void runAction('update image OCR', () => window.winUtils.clipboard.setImageOcr(event.target.checked).then(() => undefined), event.target.checked ? 'Image OCR enabled.' : 'Image OCR disabled.')}
            disabled={busy !== null}
          />
          <span>Image OCR</span>
        </label>
        <label className="clipboard-retention-field" title="Maximum unpinned clipboard entries to keep. Use 0 for unlimited.">
          <span>Max entries</span>
          <input
            type="number"
            className="macro-input macro-input--short"
            value={retentionDraft.maxEntries}
            min={0}
            max={10000}
            onChange={(event) => setRetentionDraft((draft) => ({ ...draft, maxEntries: event.target.value }))}
            onBlur={() => void applyRetentionDraft()}
            onKeyDown={(event) => { if (event.key === 'Enter') void applyRetentionDraft(); }}
            disabled={busy !== null || !state}
          />
        </label>
        <label className="clipboard-retention-field" title="Delete unpinned clipboard entries older than this many days. Use 0 to keep by age indefinitely.">
          <span>Max age days</span>
          <input
            type="number"
            className="macro-input macro-input--short"
            value={retentionDraft.retentionDays}
            min={0}
            max={3650}
            onChange={(event) => setRetentionDraft((draft) => ({ ...draft, retentionDays: event.target.value }))}
            onBlur={() => void applyRetentionDraft()}
            onKeyDown={(event) => { if (event.key === 'Enter') void applyRetentionDraft(); }}
            disabled={busy !== null || !state}
          />
        </label>
        <div className="clipboard-clear-actions">
          <button className="micro-button" type="button" onClick={() => void handleClear('unpinned')} disabled={busy !== null || !state?.total} title="Delete unpinned clipboard entries while keeping pinned items.">
            Clear Unpinned
          </button>
          <button className="micro-button micro-button--danger" type="button" onClick={() => void handleClear('all')} disabled={busy !== null || !state?.total} title="Delete all stored clipboard history, including pinned items and stored image files.">
            Clear All
          </button>
        </div>
      </div>

      <div className="clipboard-list-header">
        <strong>{visibleSummary}</strong>
        <span>{busy ? `Working: ${busy}...` : state?.settings.monitoring ? 'Watching clipboard' : 'Monitoring paused'}</span>
      </div>

      <div className="clipboard-entry-list">
        {loading ? <div className="empty-state">Loading clipboard history...</div> : null}
        {!loading && entries.length === 0 ? <div className="empty-state">No clipboard items match the current search and filters.</div> : null}
        {!loading ? entries.map((entry) => (
          <ClipboardEntryRow
            key={entry.id}
            entry={entry}
            busy={busy !== null}
            onCopy={handleCopy}
            onPinned={handlePinned}
            onDelete={handleDelete}
            onRerunOcr={(imageEntry) => runAction('run OCR', () => window.winUtils.clipboard.rerunOcr(imageEntry.id).then(() => undefined), 'OCR started for this image.')}
          />
        )) : null}
      </div>
    </div>
  );
}

function ClipboardStat({ label, value, title }: { label: string; value: number; title: string }): ReactElement {
  return (
    <div className="clipboard-stat" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ClipboardEntryRow({ entry, busy, onCopy, onPinned, onDelete, onRerunOcr }: {
  entry: ClipboardEntry;
  busy: boolean;
  onCopy: (entry: ClipboardEntry) => Promise<void>;
  onPinned: (entry: ClipboardEntry) => Promise<void>;
  onDelete: (entry: ClipboardEntry) => Promise<void>;
  onRerunOcr: (entry: ClipboardEntry) => Promise<void>;
}): ReactElement {
  const title = shortenTitle(entry.preview || 'Clipboard item');

  return (
    <article className={`clipboard-entry clipboard-entry--${entry.type} ${entry.pinned ? 'clipboard-entry--pinned' : ''}`}>
      <div className="clipboard-entry-media">{renderEntryMedia(entry)}</div>
      <div className="clipboard-entry-main">
        <div className="clipboard-entry-title-row">
          <div>
            <strong title={entry.preview || 'Clipboard item'}>{title}</strong>
            <p>{formatEntryMeta(entry)}</p>
          </div>
        </div>

        <div className="clipboard-category-row">
          {entry.categories.map((category) => (
            <span key={category} className="status-pill status-pill--info" title={`Detected category: ${categoryLabels[category] ?? category}.`}>
              {categoryLabels[category] ?? category}
            </span>
          ))}
        </div>

        {entry.type === 'files' ? <ClipboardFiles paths={entry.filePaths ?? []} /> : null}
        {entry.type === 'text' && entry.text ? <pre className="clipboard-text-preview">{entry.text}</pre> : null}
        {entry.type === 'image' ? <ClipboardOcr entry={entry} busy={busy} onRerunOcr={onRerunOcr} /> : null}
      </div>
      <div className="clipboard-entry-actions">
        <button className="micro-button" type="button" disabled={busy} onClick={() => void onCopy(entry)} title="Put this saved item back onto the Windows clipboard.">
          Copy
        </button>
        <button className="micro-button" type="button" disabled={busy} onClick={() => void onPinned(entry)} title={entry.pinned ? 'Allow this item to be removed by normal cleanup.' : 'Keep this item at the top and protect it from unpinned cleanup.'}>
          {entry.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button className="micro-button micro-button--danger" type="button" disabled={busy} onClick={() => void onDelete(entry)} title="Delete this saved clipboard item from WinUtils and matching Windows clipboard history.">
          Delete
        </button>
      </div>
    </article>
  );
}

function renderEntryMedia(entry: ClipboardEntry): ReactElement {
  if (entry.type === 'image' && entry.image?.thumbnailDataUrl) {
    return <img src={entry.image.thumbnailDataUrl} alt="Clipboard thumbnail" />;
  }

  const label = entry.type === 'files' ? 'PATH' : entry.type.toUpperCase();
  return <span>{label}</span>;
}

function ClipboardFiles({ paths }: { paths: string[] }): ReactElement {
  return (
    <div className="clipboard-file-list">
      {paths.slice(0, 6).map((filePath) => <code key={filePath}>{filePath}</code>)}
      {paths.length > 6 ? <span className="inline-note">+{paths.length - 6} more paths</span> : null}
    </div>
  );
}

function ClipboardOcr({ entry, busy, onRerunOcr }: { entry: ClipboardEntry; busy: boolean; onRerunOcr: (entry: ClipboardEntry) => Promise<void> }): ReactElement {
  const statusText = entry.ocrStatus === 'pending'
    ? 'OCR is extracting text...'
    : entry.ocrStatus === 'complete'
      ? entry.ocrText ? 'OCR text' : 'OCR finished without finding text.'
      : entry.ocrStatus === 'unsupported'
        ? entry.ocrError ?? 'OCR is unavailable for this image.'
        : entry.ocrStatus === 'error'
          ? entry.ocrError ?? 'OCR failed.'
          : entry.ocrError ?? 'OCR has not run for this image yet.';

  return (
    <div className="clipboard-ocr-box">
      <div className="clipboard-ocr-header">
        <span className={`status-pill clipboard-ocr-status clipboard-ocr-status--${entry.ocrStatus}`}>{entry.ocrStatus}</span>
        {entry.ocrStatus === 'none' || entry.ocrStatus === 'error' || entry.ocrStatus === 'unsupported' ? (
          <button className="micro-button" type="button" disabled={busy} onClick={() => void onRerunOcr(entry)} title="Run Windows OCR for this image.">
            {entry.ocrStatus === 'none' ? 'Run OCR' : 'Retry OCR'}
          </button>
        ) : null}
      </div>
      <p>{statusText}</p>
      {entry.ocrText ? <pre className="clipboard-text-preview clipboard-text-preview--ocr">{entry.ocrText}</pre> : null}
    </div>
  );
}

function formatEntryMeta(entry: ClipboardEntry): string {
  const copied = new Date(entry.copiedAt).toLocaleString();
  const size = entry.sizeBytes ? `, ${formatBytes(entry.sizeBytes)}` : '';
  const used = entry.useCount > 0 ? `, used ${entry.useCount}x` : '';
  return `${entry.type}, copied ${copied}${size}${used}`;
}

function shortenTitle(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > 88 ? `${compacted.slice(0, 87)}...` : compacted;
}

function formatHotkey(value: string): string {
  return value.replace(/CommandOrControl|CmdOrCtrl|Control/gi, 'Ctrl');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getErrorMessage(caughtError: unknown, fallback: string): string {
  if (!(caughtError instanceof Error)) {
    return typeof caughtError === 'string' && caughtError.trim() ? caughtError : fallback;
  }

  return caughtError.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}
