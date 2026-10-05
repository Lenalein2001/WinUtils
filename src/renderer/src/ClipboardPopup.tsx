import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ClipboardEntry, ClipboardState } from '../../shared/clipboard';

export function ClipboardPopup(): ReactElement {
  const [state, setState] = useState<ClipboardState | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      setState(await window.winUtils.clipboard.getState({ limit: 100 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const entries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return state?.entries ?? [];
    return (state?.entries ?? []).filter(entry => searchableText(entry).includes(query));
  }, [search, state?.entries]);

  const selectEntry = useCallback(async (entry: ClipboardEntry): Promise<void> => {
    setBusyId(entry.id);
    setError(null);
    try {
      await window.winUtils.clipboard.copy(entry.id);
      await window.winUtils.clipboard.hideQuickAccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusyId(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribeChanged = window.winUtils.clipboard.onChanged(() => void load());
    const unsubscribeOpened = window.winUtils.clipboard.onOpenRequested(() => {
      setSearch('');
      setSelectedIndex(0);
      setBusyId(null);
      void load();
      window.setTimeout(() => searchRef.current?.focus(), 0);
    });
    return () => {
      unsubscribeChanged();
      unsubscribeOpened();
    };
  }, [load]);

  useEffect(() => {
    setSelectedIndex(index => Math.min(index, Math.max(entries.length - 1, 0)));
  }, [entries.length]);

  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-clipboard-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex(index => Math.min(index + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && entries[selectedIndex]) {
      event.preventDefault();
      void selectEntry(entries[selectedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void window.winUtils.clipboard.hideQuickAccess();
    }
  };

  return (
    <main className="clipboard-popup" onKeyDown={handleKeyDown}>
      <header className="clipboard-popup__header">
        <div>
          <span className="clipboard-popup__eyebrow">WinUtils</span>
          <h1>Clipboard history</h1>
        </div>
        <button
          type="button"
          className="clipboard-popup__close"
          aria-label="Close clipboard history"
          onClick={() => void window.winUtils.clipboard.hideQuickAccess()}
        >
          X
        </button>
      </header>

      <label className="clipboard-popup__search">
        <span aria-hidden="true">?</span>
        <input
          ref={searchRef}
          value={search}
          onChange={event => {
            setSearch(event.target.value);
            setSelectedIndex(0);
          }}
          placeholder="Search clipboard history"
          autoFocus
        />
      </label>

      <div className="clipboard-popup__body">
        {error ? <div className="clipboard-popup__error">{error}</div> : null}
        <div className="clipboard-popup__list" role="listbox" aria-label="Clipboard history">
          {!state ? <div className="clipboard-popup__empty">Loading history...</div> : null}
          {state && entries.length === 0 ? (
            <div className="clipboard-popup__empty">
              {search ? 'No clipboard items match your search.' : 'Clipboard history is empty.'}
            </div>
          ) : null}
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-clipboard-index={index}
              className={`clipboard-popup-item${index === selectedIndex ? ' clipboard-popup-item--selected' : ''}`}
              disabled={busyId !== null}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => void selectEntry(entry)}
            >
              <span className={`clipboard-popup-item__media clipboard-popup-item__media--${entry.type}`}>
                {entry.type === 'image' && entry.image?.thumbnailDataUrl
                  ? <img src={entry.image.thumbnailDataUrl} alt="" />
                  : entry.type === 'files' ? 'FILE' : 'TXT'}
              </span>
              <span className="clipboard-popup-item__body">
                <strong>{entryTitle(entry)}</strong>
                <small>
                  {entry.pinned ? 'Pinned / ' : ''}
                  {entry.type === 'files' ? `${entry.filePaths?.length ?? 0} file(s)` : entry.type}
                  {' / '}
                  {relativeTime(entry.copiedAt)}
                </small>
              </span>
              {entry.pinned ? <span className="clipboard-popup-item__pin" title="Pinned">P</span> : null}
            </button>
          ))}
        </div>
      </div>

      <footer className="clipboard-popup__footer">
        <span><kbd>Up</kbd><kbd>Dn</kbd> Navigate</span>
        <span><kbd>Enter</kbd> Copy</span>
        <span><kbd>Esc</kbd> Close</span>
      </footer>
    </main>
  );
}

function searchableText(entry: ClipboardEntry): string {
  return [
    entry.preview,
    entry.text,
    entry.ocrText,
    ...(entry.filePaths ?? []),
    ...entry.categories,
  ].filter(Boolean).join('\n').toLowerCase();
}

function entryTitle(entry: ClipboardEntry): string {
  const source = entry.type === 'files'
    ? entry.filePaths?.[0] ?? entry.preview
    : entry.type === 'image'
      ? entry.ocrText || 'Copied image'
      : entry.text || entry.preview;
  const compact = source.replace(/\s+/g, ' ').trim();
  return compact.length > 110 ? `${compact.slice(0, 107)}...` : compact || 'Clipboard item';
}

function relativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (elapsedSeconds < 60) return 'just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
