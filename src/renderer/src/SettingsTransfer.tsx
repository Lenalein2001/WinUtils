import { useState, type ReactElement } from 'react';
import type { AppSettings } from '../../shared/settings';

const preferenceNames: Record<keyof AppSettings, string> = {
  theme: 'Theme', launchAtLogin: 'Start with Windows', startMinimized: 'Start minimized',
  minimizeToTray: 'Minimize to tray', closeToTray: 'Close to tray',
};
const preferenceValue = (value: AppSettings[keyof AppSettings]): string => typeof value === 'boolean'
  ? value ? 'On' : 'Off' : ({ 'winutils-blue': 'Ocean', 'sable-night': 'Tactical', 'sable-ember': 'Ember' }[value] ?? value);

export function SettingsTransfer({ current, onChanged }: { current: AppSettings; onChanged: (settings: AppSettings) => void }): ReactElement {
  const [preview, setPreview] = useState<AppSettings | null>(null);
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (caught) { setError(String(caught)); } finally { setBusy(false); }
  };
  return <div className="settings-card">
    <strong>App preferences</strong>
    <p>Back up your theme, startup and tray settings.</p>
    <div className="settings-update-actions">
      <button className="ghost-button" disabled={busy} onClick={() => void run(async () => { if (await window.winUtils.settings.export()) setMessage('App preferences exported.'); })}>Export preferences</button>
      <button className="ghost-button" disabled={busy} onClick={() => void run(async () => { setReset(false); setPreview(await window.winUtils.settings.importPreview()); })}>Import preferences</button>
      <button className="ghost-button" disabled={busy} onClick={() => { setPreview(null); setReset(true); }}>Reset app behavior</button>
    </div>
    {message && <p role="status">{message}</p>}{error && <div className="error-banner" role="alert">{error}</div>}
    {preview && <div><p>Import preview</p><table style={{ width: '100%', borderSpacing: '8px', textAlign: 'left', overflowWrap: 'anywhere' }}><thead><tr><th>Preference</th><th>Current</th><th>Imported</th></tr></thead><tbody>
      {(Object.keys(current) as Array<keyof AppSettings>).map(key => <tr key={key}><td>{preferenceNames[key]}</td><td>{preferenceValue(current[key])}</td><td>{preferenceValue(preview[key])}</td></tr>)}
    </tbody></table>
      <button className="ghost-button" disabled={busy} onClick={() => setPreview(null)}>Cancel import</button>{' '}
      <button className="toggle-button" disabled={busy} onClick={() => void run(async () => { onChanged(await window.winUtils.settings.update(preview)); setPreview(null); setMessage('App preferences imported.'); })}>Apply imported preferences</button>
    </div>}
    {reset && <div className="warning-banner"><p>Restore default preferences and turn off Start with Windows? Saved history and automations are kept.</p>
      <button className="ghost-button" disabled={busy} onClick={() => setReset(false)}>Cancel reset</button>{' '}
      <button className="toggle-button" disabled={busy} onClick={() => void run(async () => { onChanged(await window.winUtils.settings.reset()); setReset(false); setMessage('App behavior reset.'); })}>Confirm reset</button>
    </div>}
  </div>;
}
