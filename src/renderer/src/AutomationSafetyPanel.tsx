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
    <button className="danger-button" disabled={busy} onClick={() => void change()}>{busy ? 'Working…' : activity?.paused ? 'Resume actions' : 'Emergency stop'}</button>
    {activity?.paused && <small>Audio and window protection stay disabled until you enable them again.</small>}
    {activity?.running.length ? <small>{activity.running.map(run => run.actionId).join(', ')}</small> : null}
    {error && <div className="error-banner" role="alert">{error}</div>}
  </div>;
}
