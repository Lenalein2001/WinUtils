import { useEffect, useState } from 'react';
import type { AutomationActivity } from '../../shared/actions';

export function AutomationSafetyPanel() {
  const [activity, setActivity] = useState<AutomationActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void window.winUtils.actions.activity().then(value => { if (!disposed) setActivity(value); }).catch(() => undefined); };
    refresh(); const timer = setInterval(refresh, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const change = async () => {
    setBusy(true); setError(null);
    try { setActivity(await (activity?.paused ? window.winUtils.actions.resume() : window.winUtils.actions.stop())); }
    catch (failure) { setError(String(failure)); await window.winUtils.actions.activity().then(setActivity).catch(() => undefined); }
    finally { setBusy(false); }
  };
  return <div className="automation-safety" aria-live="polite">
    <span>{activity?.paused ? 'Automation paused' : `${activity?.running.length ?? 0} active · ${activity?.pending ?? 0} pending`}</span>
    <button className="micro-button micro-button--danger" disabled={busy} onClick={() => void change()}>{busy ? 'Working…' : activity?.paused ? 'Resume actions' : 'Emergency stop'}</button>
    {activity?.paused && <small>Audio and window protection stay disabled until you enable them again.</small>}
    {activity?.running.length ? <small>{activity.running.map(run => run.label).join(', ')}</small> : null}
    <details className="automation-history" aria-live="off">
      <summary>Recent actions ({activity?.recent.length ?? 0}){activity?.recent.some(run => !run.ok) ? ' · failures recorded' : ''}</summary>
      <p>Last 50 actions from this session. Times include waiting in the queue.</p>
      <button className="micro-button" disabled={busy || !activity?.recent.length} onClick={() => {
        setBusy(true);
        void window.winUtils.actions.clearHistory().then(setActivity).catch(failure => setError(String(failure))).finally(() => setBusy(false));
      }}>Clear activity history</button>
      {!activity?.recent.length && <p>No completed actions yet.</p>}
      <ol>{activity?.recent.map(run => <li key={run.id}>
        <strong>{run.label}</strong> · {run.ok ? 'Completed' : 'Failed'} · {(run.durationMs / 1000).toFixed(1)}s · {new Date(run.finishedAt).toLocaleTimeString()}
        {run.error && <p className="error-banner">{run.error}</p>}
      </li>)}</ol>
    </details>
    {error && <div className="error-banner" role="alert">{error}</div>}
  </div>;
}
