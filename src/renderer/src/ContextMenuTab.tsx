import { useEffect, useState, type ReactElement } from 'react';
import type { ExplorerContextMenuState } from '../../shared/contextMenu';

export function ContextMenuTab(): ReactElement {
  const [state, setState] = useState<ExplorerContextMenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  const load = async (): Promise<void> => {
    setError(null);
    try {
      setState(await window.winUtils.contextMenu.getState());
    } catch (reason) {
      setError(cleanError(reason));
    }
  };

  const save = async (): Promise<void> => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      setState(await window.winUtils.contextMenu.update({
        entries: state.entries.map(entry => ({ actionId: entry.actionId, enabled: entry.enabled })),
      }));
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.winUtils.contextMenu.uninstall());
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="context-menu-manager module-shell">
      <header className="context-menu-manager__header">
        <div>
          <p className="section-kicker">Explorer integration</p>
          <h2>Context Menu</h2>
          <p>Expose a small allowlisted set of WinUtils actions directly in Windows Explorer.</p>
        </div>
        <span className={`status-pill ${state?.installed ? 'status-pill--success' : ''}`}>
          {state?.installed ? 'Installed' : 'Not installed'}
        </span>
      </header>

      {error || state?.error ? <div className="error-banner">{error ?? state?.error}</div> : null}

      <section className="context-menu-manager__card">
        <div>
          <p className="section-kicker">WinUtils submenu</p>
          <h3>Choose Explorer actions</h3>
          <p>Entries are registered only for your Windows account and can be removed at any time.</p>
        </div>
        <div className="context-menu-manager__entries">
          {state?.entries.map(entry => (
            <label className="context-menu-entry" key={entry.actionId}>
              <input
                type="checkbox"
                checked={entry.enabled}
                onChange={event => setState(current => current ? {
                  ...current,
                  entries: current.entries.map(item => item.actionId === entry.actionId
                    ? { ...item, enabled: event.target.checked }
                    : item),
                } : current)}
              />
              <div>
                <strong>{entry.label}</strong>
                <span>{entry.description}</span>
                <small>{entry.targets.map(target => target === 'files' ? 'Files' : 'Folders').join(' and ')}</small>
              </div>
            </label>
          ))}
        </div>
        <div className="context-menu-manager__actions">
          <button type="button" className="primary-button" disabled={busy || !state} onClick={() => void save()}>
            {busy ? 'Applying...' : 'Apply to Explorer'}
          </button>
          <button type="button" className="danger-button" disabled={busy || !state?.installed} onClick={() => void uninstall()}>
            Remove integration
          </button>
        </div>
      </section>

      <section className="context-menu-manager__details">
        <strong>Reversible and local</strong>
        <p>
          WinUtils writes only its own <code>HKCU\Software\Classes</code> keys. No administrator access,
          shell extension DLL, or network service is used.
        </p>
        <small title={state?.executablePath}>{state?.executablePath}</small>
      </section>
    </div>
  );
}

function cleanError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '');
}
