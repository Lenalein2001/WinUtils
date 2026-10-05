import { useState, type ReactElement } from 'react';
import type { FileRecoveryItem } from '../../shared/fileSync';

export function FileRecoveryPanel(): ReactElement {
  const [items, setItems] = useState<FileRecoveryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ item: FileRecoveryItem; purge: boolean } | null>(null);
  const refresh = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { setItems(await window.winUtils.fileSync.listRecovery()); }
    catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  const act = async (): Promise<void> => {
    if (!confirmation || busy) return;
    setBusy(true); setError(null);
    try {
      if (confirmation.purge) await window.winUtils.fileSync.purgeRecovery(confirmation.item.id);
      else await window.winUtils.fileSync.restoreRecovery(confirmation.item.id);
      setConfirmation(null); setItems(await window.winUtils.fileSync.listRecovery());
    } catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="settings-card">
    <strong>File recovery</strong>
    <p>Restore previous file versions without replacing existing files.</p>
    <button className="ghost-button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Working…' : 'Browse recovery copies'}</button>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {confirmation && <div className="warning-banner" role="alert">
      <p style={{ overflowWrap: 'anywhere' }}>{confirmation.purge ? 'Permanently delete this recovery copy?' : 'Restore this copy to its original path?'} {confirmation.item.originalPath}</p>
      <button className="ghost-button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>{' '}
      <button className="toggle-button" disabled={busy} onClick={() => void act()}>{confirmation.purge ? 'Delete permanently' : 'Restore copy'}</button>
    </div>}
    {items?.length === 0 && <p>No recovery copies recorded. Older quarantine folders remain on disk.</p>}
    {items?.map(item => <div className="settings-row settings-row--stack" key={item.id}>
      <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><strong>{item.jobName}</strong><p>{item.originalPath}</p>
        <small>{new Date(item.createdAt).toLocaleString()} · {(item.sizeBytes / 1024).toFixed(1)} KB · {item.complete ? 'Sync completed' : 'Incomplete sync — kept for recovery'}{item.collision ? ' · File already exists' : ''}</small></div>
      <div><button className="ghost-button" disabled={busy || item.collision} onClick={() => setConfirmation({ item, purge: false })}>Restore</button>{' '}
        <button className="micro-button micro-button--danger" disabled={busy || !item.complete} onClick={() => setConfirmation({ item, purge: true })}>Purge</button></div>
    </div>)}
  </div>;
}
