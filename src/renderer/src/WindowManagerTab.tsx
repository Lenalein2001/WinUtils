import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  ManagedWindow,
  WindowCommand,
  WindowManagerState,
  WindowPlacementPreset,
} from '../../shared/windowManager';

const presets: Array<{ value: WindowPlacementPreset; label: string }> = [
  { value: 'left-half', label: 'Left half' },
  { value: 'right-half', label: 'Right half' },
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'center', label: 'Center' },
  { value: 'fullscreen', label: 'Work area' },
];

export function WindowManagerTab(): ReactElement {
  const [state, setState] = useState<WindowManagerState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayId, setDisplayId] = useState('');
  const [preset, setPreset] = useState<WindowPlacementPreset>('left-half');
  const [bounds, setBounds] = useState({ x: '0', y: '0', width: '960', height: '1080' });
  const [layoutName, setLayoutName] = useState('');
  const [captureIds, setCaptureIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.winUtils.windows.getState();
      setState(next);
      setCaptureIds(current => new Set([...current].filter(id => next.windows.some(item => item.id === id))));
      setSelectedId(current => current && next.windows.some(item => item.id === current)
        ? current
        : next.windows[0]?.id ?? null);
      setDisplayId(current => current && next.displays.some(item => item.id === current)
        ? current
        : next.displays.find(item => item.primary)?.id ?? next.displays[0]?.id ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = state?.windows.find(window => window.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return state?.windows ?? [];
    return (state?.windows ?? []).filter(window => (
      window.title.toLowerCase().includes(query)
      || window.processName.toLowerCase().includes(query)
      || window.processPath?.toLowerCase().includes(query)
    ));
  }, [search, state?.windows]);

  useEffect(() => {
    if (!selected) return;
    setBounds({
      x: String(selected.bounds.x),
      y: String(selected.bounds.y),
      width: String(selected.bounds.width),
      height: String(selected.bounds.height),
    });
    if (selected.displayId) setDisplayId(selected.displayId);
  }, [
    selected?.id,
    selected?.bounds.x,
    selected?.bounds.y,
    selected?.bounds.width,
    selected?.bounds.height,
    selected?.displayId,
  ]);

  const execute = useCallback(async (command: WindowCommand): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.winUtils.windows.execute(command);
      setState(result.state);
      if (!result.ok) setError(cleanError(result.error ?? 'The window action failed.'));
    } catch (reason) {
      setError(cleanError(reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveLayout = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.winUtils.windows.saveLayout({
        name: layoutName,
        windowIds: [...captureIds],
      });
      setState(next);
      setLayoutName('');
      setNotice('Window layout saved. Saving the same name again replaces it.');
    } catch (reason) {
      setError(cleanError(reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  };

  const applyLayout = async (layoutId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.winUtils.windows.applyLayout(layoutId);
      setState(result.state);
      const details = [
        `${result.applied} window${result.applied === 1 ? '' : 's'} positioned.`,
        result.unmatched.length ? `Not open: ${result.unmatched.join(', ')}.` : '',
        result.errors.length ? `Failed: ${result.errors.join(' ')}` : '',
      ].filter(Boolean).join(' ');
      if (result.ok) setNotice(details);
      else setError(details);
    } catch (reason) {
      setError(cleanError(reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  };

  const deleteLayout = async (layoutId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setState(await window.winUtils.windows.deleteLayout(layoutId));
    } catch (reason) {
      setError(cleanError(reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setBusy(false);
    }
  };

  const simpleCommand = (type: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'hide' | 'show'): void => {
    if (selected) void execute({ type, windowId: selected.id });
  };

  return (
    <div className="window-manager module-shell">
      <div className="window-manager__toolbar">
        <div>
          <p className="section-kicker">Window Manager</p>
          <h2>Open desktop windows</h2>
          <p>Control visible top-level windows across {state?.displays.length ?? 0} connected monitor(s).</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Refreshing...' : 'Refresh windows'}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => {
          setBusy(true); setError(null);
          void window.winUtils.windows.restoreAll().then(setState)
            .catch(reason => setError(String(reason))).finally(() => setBusy(false));
        }}>Restore all hidden windows</button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="success-banner">{notice}</div> : null}

      <section className="window-layouts">
        <div className="window-layouts__header">
          <div>
            <p className="section-kicker">Saved layouts</p>
            <h3>Restore a desktop arrangement</h3>
          </div>
          <div className="window-layouts__save">
            <input
              className="macro-input"
              value={layoutName}
              onChange={event => setLayoutName(event.target.value)}
              placeholder="Layout name"
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCaptureIds(new Set(state?.windows.map(item => item.id) ?? []))}
              disabled={busy || !state?.windows.length}
            >
              Select all
            </button>
            <button type="button" className="primary-button" onClick={() => void saveLayout()} disabled={busy}>
              Save selected
            </button>
          </div>
        </div>
        {state?.layouts.length ? (
          <div className="window-layouts__list">
            {state.layouts.map(layout => (
              <div className="window-layout-item" key={layout.id}>
                <div>
                  <strong>{layout.name}</strong>
                  <small>{layout.placements.length} window{layout.placements.length === 1 ? '' : 's'}</small>
                </div>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void applyLayout(layout.id)}>
                  Apply
                </button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => void deleteLayout(layout.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : <p className="window-layouts__empty">Select windows below, enter a name, and save their monitor-relative positions.</p>}
      </section>

      <div className="window-manager__layout">
        <aside className="window-manager__list-panel">
          <input
            className="macro-input"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search windows..."
          />
          <div className="window-manager__list">
            {filtered.map(window => (
              <div className="window-manager-row" key={window.id}>
                <input
                  type="checkbox"
                  aria-label={`Include ${window.title} in saved layout`}
                  checked={captureIds.has(window.id)}
                  onChange={event => setCaptureIds(current => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(window.id);
                    else next.delete(window.id);
                    return next;
                  })}
                />
                <button
                  type="button"
                  className={`window-manager-item${selectedId === window.id ? ' window-manager-item--selected' : ''}`}
                  onClick={() => setSelectedId(window.id)}
                >
                  <span>{window.processName.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{window.title}</strong>
                    <small>{window.processName}.exe / PID {window.processId}</small>
                  </div>
                  <em>{window.hidden ? 'hidden' : window.state}</em>
                </button>
              </div>
            ))}
            {!busy && filtered.length === 0 ? <div className="empty-state">No matching windows.</div> : null}
          </div>
        </aside>

        <section className="window-manager__details">
          {!selected ? <div className="empty-state">Select a window to manage it.</div> : (
            <>
              <div className="window-manager__identity">
                <div>
                  <p className="section-kicker">Selected window</p>
                  <h3>{selected.title}</h3>
                  <code>{selected.processPath ?? `${selected.processName}.exe`}</code>
                </div>
                <span className={`status-pill ${selected.alwaysOnTop ? 'status-pill--info' : ''}`}>
                  {selected.alwaysOnTop ? 'Always on top' : selected.state}
                </span>
              </div>

              <div className="window-manager__actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => simpleCommand('focus')}>Focus</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => simpleCommand('minimize')}>Minimize</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => simpleCommand('maximize')}>Maximize</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => simpleCommand('restore')}>Restore</button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void execute({ type: 'set-always-on-top', windowId: selected.id, enabled: !selected.alwaysOnTop })}
                >
                  {selected.alwaysOnTop ? 'Disable topmost' : 'Always on top'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => simpleCommand(selected.hidden ? 'show' : 'hide')}
                >
                  {selected.hidden ? 'Show' : 'Hide'}
                </button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => simpleCommand('close')}>Close</button>
              </div>

              <div className="window-manager-card">
                <div>
                  <p className="section-kicker">Position preset</p>
                  <h4>Move on monitor</h4>
                </div>
                <div className="window-manager__preset-controls">
                  <select className="macro-select" value={displayId} onChange={event => setDisplayId(event.target.value)}>
                    {state?.displays.map(display => (
                      <option key={display.id} value={display.id}>
                        {display.label}{display.primary ? ' (Primary)' : ''} - {display.workArea.width}x{display.workArea.height}
                      </option>
                    ))}
                  </select>
                  <select className="macro-select" value={preset} onChange={event => setPreset(event.target.value as WindowPlacementPreset)}>
                    {presets.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !displayId}
                    onClick={() => void execute({ type: 'apply-preset', windowId: selected.id, displayId, preset })}
                  >
                    Apply preset
                  </button>
                </div>
              </div>

              <div className="window-manager-card">
                <div>
                  <p className="section-kicker">Exact bounds</p>
                  <h4>Desktop coordinates</h4>
                </div>
                <div className="window-manager__bounds">
                  {(['x', 'y', 'width', 'height'] as const).map(field => (
                    <label key={field}>
                      <span>{field.toUpperCase()}</span>
                      <input
                        type="number"
                        className="macro-input"
                        value={bounds[field]}
                        onChange={event => setBounds(current => ({ ...current, [field]: event.target.value }))}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void execute({
                      type: 'move-resize',
                      windowId: selected.id,
                      x: Number(bounds.x),
                      y: Number(bounds.y),
                      width: Number(bounds.width),
                      height: Number(bounds.height),
                    })}
                  >
                    Apply bounds
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function cleanError(value: string): string {
  return value
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}
