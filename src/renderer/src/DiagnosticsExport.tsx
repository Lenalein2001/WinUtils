import { useState, type ReactElement } from 'react';

export function DiagnosticsExport(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setMessage(null); setError(null);
    try { if (await window.winUtils.diagnostics.export()) setMessage('Diagnostics saved.'); }
    catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="settings-card">
    <strong>Diagnostic summary</strong>
    <p>Save app and runtime versions, uptime and memory use for troubleshooting.</p>
    <button className="ghost-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Export diagnostics'}</button>
    {message && <p role="status">{message}</p>}{error && <div className="error-banner" role="alert">{error}</div>}
  </div>;
}
