import { useEffect, useState, type ReactElement } from 'react';
import type { AppSettings } from '../../shared/settings';
import type { UpdateState } from '../../shared/updater';

interface SettingsTabProps {
  settings: AppSettings | null;
  busy: boolean;
  onToggleLaunchAtLogin: (value: boolean) => void;
  onToggleStartMinimized: (value: boolean) => void;
  onToggleMinimizeToTray: (value: boolean) => void;
  onToggleCloseToTray: (value: boolean) => void;
}

export function SettingsTab({
  settings,
  busy,
  onToggleLaunchAtLogin,
  onToggleStartMinimized,
  onToggleMinimizeToTray,
  onToggleCloseToTray,
}: SettingsTabProps): ReactElement {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    void window.winUtils.updates.getState().then((state) => {
      if (mounted) setUpdateState(state);
    });

    const unsubscribe = window.winUtils.updates.onState((state) => setUpdateState(state));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const runUpdateAction = async (action: () => Promise<UpdateState | void>): Promise<void> => {
    setUpdateBusy(true);
    try {
      const nextState = await action();
      if (nextState) setUpdateState(nextState);
    } catch (error) {
      setUpdateState((state) => state ? { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) } : state);
    } finally {
      setUpdateBusy(false);
    }
  };

  if (!settings) {
    return <div className="empty-state">Loading settings...</div>;
  }

  const updateStatus = updateState ? formatUpdateStatus(updateState) : 'Loading update status...';
  const updateDisabled = updateBusy || updateState?.status === 'checking' || updateState?.status === 'downloading';
  const updatePercent = Math.max(0, Math.min(100, updateState?.progress?.percent ?? 0));

  return (
    <div className="settings-layout">
      <div className="content-header">
        <div>
          <p className="section-kicker">Settings</p>
          <h2>App behavior</h2>
        </div>
      </div>

      <div className="settings-card">
        <label className="settings-row">
          <div>
            <strong>Launch at Windows login</strong>
            <p>Automatically open WinUtils when you sign into Windows.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            disabled={busy}
            onChange={(event) => onToggleLaunchAtLogin(event.target.checked)}
          />
        </label>

        <label className="settings-row">
          <div>
            <strong>Start minimized</strong>
            <p>When launched from startup, start in the system tray instead of focused.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.startMinimized}
            disabled={busy}
            onChange={(event) => onToggleStartMinimized(event.target.checked)}
          />
        </label>

        <label className="settings-row">
          <div>
            <strong>Minimize to tray</strong>
            <p>Hide to system tray when minimized instead of showing in the taskbar.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.minimizeToTray}
            disabled={busy}
            onChange={(event) => onToggleMinimizeToTray(event.target.checked)}
          />
        </label>

        <label className="settings-row">
          <div>
            <strong>Close to tray</strong>
            <p>Keep running in the system tray when the window is closed.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.closeToTray}
            disabled={busy}
            onChange={(event) => onToggleCloseToTray(event.target.checked)}
          />
        </label>
      </div>

      <div className="settings-card settings-card--updates">
        <div className="settings-update-header">
          <div>
            <strong>Updates</strong>
            <p>{updateStatus}</p>
          </div>
          <span className={`status-pill status-pill--${updateState?.status === 'available' || updateState?.status === 'downloaded' ? 'enabled' : 'disabled'}`}>
            {updateState?.status ?? 'loading'}
          </span>
        </div>

        {updateState?.progress ? (
          <div className="settings-update-progress" aria-label="Update download progress">
            <span style={{ width: `${updatePercent}%` }} />
          </div>
        ) : null}

        {updateState?.error ? <div className="error-banner">{updateState.error}</div> : null}

        <div className="settings-update-actions">
          <button
            className="ghost-button"
            type="button"
            disabled={!updateState?.canCheck || updateDisabled}
            onClick={() => void runUpdateAction(() => window.winUtils.updates.check())}
          >
            {updateState?.status === 'checking' ? 'Checking...' : 'Check Now'}
          </button>

          {updateState?.canDownload ? (
            <button
              className="toggle-button"
              type="button"
              disabled={updateDisabled}
              onClick={() => void runUpdateAction(() => window.winUtils.updates.download())}
            >
              {updateState.installMode === 'portable' ? 'Open Download' : updateState.status === 'downloading' ? 'Downloading...' : 'Download Update'}
            </button>
          ) : null}

          {updateState?.canInstall ? (
            <button className="toggle-button" type="button" disabled={updateBusy} onClick={() => void runUpdateAction(() => window.winUtils.updates.install())}>
              Install and Restart
            </button>
          ) : null}

          <button className="ghost-button" type="button" onClick={() => void window.winUtils.updates.openReleasePage()}>
            Releases
          </button>
        </div>
      </div>
    </div>
  );
}

function formatUpdateStatus(state: UpdateState): string {
  if (state.installMode === 'development') return `WinUtils ${state.currentVersion}. Update checks run in packaged builds.`;
  if (state.status === 'checking') return 'Checking GitHub releases for a newer version...';
  if (state.status === 'downloading') return `Downloading WinUtils ${state.update?.version ?? ''} (${Math.round(state.progress?.percent ?? 0)}%).`;
  if (state.status === 'downloaded') return `WinUtils ${state.update?.version} is ready to install.`;
  if (state.status === 'available') {
    return state.installMode === 'portable'
      ? `WinUtils ${state.update?.version} is available. Portable builds download the new EXE instead of self-installing.`
      : `WinUtils ${state.update?.version} is available.`;
  }
  if (state.status === 'not-available') return `WinUtils ${state.currentVersion} is up to date.`;
  if (state.status === 'error') return 'Update check failed.';
  return `WinUtils ${state.currentVersion}.`;
}
