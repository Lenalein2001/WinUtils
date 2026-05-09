import type { ReactElement } from 'react';
import type { AppSettings } from '../../shared/settings';

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
  if (!settings) {
    return <div className="empty-state">Loading settings...</div>;
  }

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
            <p>When launched from startup, open minimized instead of focused.</p>
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
    </div>
  );
}
