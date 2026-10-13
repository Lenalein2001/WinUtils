import { useEffect, useRef, useState } from 'react';
import type { MacroRecordingState } from '../../shared/macroRecording';
import type { MacroState } from '../../shared/macro';

export function MacroRecorderPanel({ onSaved }: { onSaved: (state: MacroState) => void }) {
  const [recording, setRecording] = useState<MacroRecordingState | null>(null);
  const [keyboard, setKeyboard] = useState(true), [mouse, setMouse] = useState(true), [movement, setMovement] = useState(false);
  const [excluded, setExcluded] = useState('1Password, KeePass, KeePassXC, Bitwarden');
  const [name, setName] = useState('Recorded macro'), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [acceptIncomplete, setAcceptIncomplete] = useState(false);
  const epoch = useRef(0), api = window.winUtils.macros;
  const phase = recording?.phase ?? 'idle';
  useEffect(() => {
    let live = true, inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true; const revision = epoch.current;
      try { const next = await api.getRecording(); if (live && revision === epoch.current) setRecording(next); }
      catch (failure) { if (live) setError(failure instanceof Error ? failure.message : 'Unable to read recording state.'); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = phase === 'countdown' || phase === 'recording' ? setInterval(() => void refresh(), 750) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [phase, api]);
  const perform = async (action: () => Promise<MacroRecordingState>) => {
    epoch.current++; setBusy(true); setError(null);
    try { setRecording(await action()); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Recording failed.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    epoch.current++; setBusy(true); setError(null);
    try { onSaved(await api.saveRecording(name, acceptIncomplete)); setRecording(await api.getRecording()); setAcceptIncomplete(false); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save recording.'); }
    finally { setBusy(false); }
  };
  return <div className="macro-runtime-panel">
    <div className="macro-runtime-header"><span className="process-bindings-label">Record macro</span>
      <span className="inline-note">{phase === 'countdown' ? `Starting in ${Math.ceil((recording?.countdownMs ?? 0) / 1000)}s` : phase === 'recording' ? `Recording · ${recording?.eventCount ?? 0} events` : phase === 'ready' ? `${recording?.eventCount ?? 0} events captured` : 'F8 stops recording'}</span>
    </div>
    {phase === 'idle' ? <>
      <div className="action-fields">
        <label><input type="checkbox" checked={keyboard} disabled={busy} onChange={e => setKeyboard(e.target.checked)} /> Keyboard</label>
        <label><input type="checkbox" checked={mouse} disabled={busy} onChange={e => setMouse(e.target.checked)} /> Mouse</label>
        <label><input type="checkbox" checked={movement} disabled={busy || !mouse} onChange={e => setMovement(e.target.checked)} /> Movement</label>
        <button className="ghost-button ghost-button--xs" disabled={busy || (!keyboard && !mouse)} onClick={() => {
          setAcceptIncomplete(false); void perform(() => api.startRecording({ keyboard, mouse, movement: mouse && movement, countdownSeconds: 3, excludedProcesses: excluded.split(',').map(n => n.trim()).filter(Boolean) }));
        }}>Start · 3s</button>
      </div>
      <details><summary className="inline-note">Recording privacy</summary><label className="macro-label">Excluded applications</label>
        <input className="macro-input" value={excluded} disabled={busy} onChange={e => setExcluded(e.target.value)} placeholder="Process names, separated by commas" />
        <p className="inline-note">WinUtils and injected input are excluded. Stop before typing sensitive information. Limit: 5 minutes.</p>
      </details>
    </> : <div className="action-fields">
      {phase !== 'ready' ? <button className="ghost-button ghost-button--xs" disabled={busy} onClick={() => void perform(() => api.stopRecording())}>Stop · F8</button> : <>
        <input className="macro-input" value={name} disabled={busy} maxLength={512} aria-label="Recording name" onChange={e => setName(e.target.value)} />
        <button className="ghost-button ghost-button--xs" disabled={busy || !name.trim() || !recording?.draft?.events.length || !!recording?.error || (!!recording?.dropped && !acceptIncomplete)} onClick={() => void save()}>Save as macro</button>
      </>}
      <button className="ghost-button ghost-button--xs" disabled={busy} onClick={() => void perform(() => api.discardRecording())}>Discard</button>
    </div>}
    {!!recording?.draft?.metadata.repaired && <p className="inline-note">{recording.draft.metadata.repaired} held inputs completed at the recording boundary.</p>}
    {!!recording?.dropped && <label className="inline-note"><input type="checkbox" checked={acceptIncomplete} onChange={e => setAcceptIncomplete(e.target.checked)} /> Recording incomplete ({recording.dropped} dropped events). Save anyway.</label>}
    {(error || recording?.error) && <p className="error-banner">{error ?? recording?.error}</p>}
  </div>;
}
