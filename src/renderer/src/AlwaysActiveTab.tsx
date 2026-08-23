import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AlwaysActiveMode, AlwaysActiveRule, AlwaysActiveState, AlwaysActiveWindow } from '../../shared/alwaysActive';

const modeOptions: Array<{ value: AlwaysActiveMode; label: string; title: string }> = [
  { value: 'prevent-deactivation', label: 'Prevent Deactivation', title: 'Inject a window hook into the selected app thread and suppress deactivate messages before the app sees them.' },
  { value: 'game-keepalive', label: 'Game Keepalive', title: 'Send throttled active-window messages for borderless games that pause when they lose focus.' },
  { value: 'active-signal', label: 'Signal Active', title: 'Send repeated active-window messages to the selected app without stealing foreground focus.' },
  { value: 'keep-foreground', label: 'Focus Lock', title: 'Bring the selected app back to the foreground when Windows focus moves away.' },
];

export function AlwaysActiveTab(): ReactElement {
  const [state, setState] = useState<AlwaysActiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paused = useMemo(() => {
    if (!state?.settings.pausedUntil) return false;
    return new Date(state.settings.pausedUntil).getTime() > Date.now();
  }, [state?.settings.pausedUntil]);
  const activeRuleCount = state?.workerStatus.lastAppliedRuleIds.length ?? 0;
  const managedWindowCount = state?.windows.filter((window) => window.ruleIds.length > 0).length ?? 0;

  useEffect(() => {
    void loadState();
    const unsubscribe = window.winUtils.alwaysActive.onChanged(() => {
      void loadState(false);
    });
    const interval = window.setInterval(() => {
      void loadState(false);
    }, 2500);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, []);

  const loadState = async (showSpinner = true): Promise<void> => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      setState(await window.winUtils.alwaysActive.getState());
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, 'Unable to load Always Active state.'));
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const runAction = async (label: string, action: () => Promise<AlwaysActiveState>, success?: string): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      setState(await action());
      if (success) setMessage(success);
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, `Unable to ${label}.`));
    } finally {
      setBusy(null);
    }
  };

  const setRuleMode = async (rule: AlwaysActiveRule, mode: AlwaysActiveMode): Promise<void> => {
    await runAction('update rule mode', () => window.winUtils.alwaysActive.updateRule({ id: rule.id, mode }), 'Mode updated.');
  };

  return (
    <div className="always-active-layout module-shell module-shell--always-active">
      <div className="always-active-header">
        <div>
          <p className="section-kicker">Always Active</p>
          <div className="always-active-title-row">
            <h2>Keep selected apps active</h2>
            <span className="always-active-beta" title="Always Active is a beta feature and its hook behavior may change as more apps and games are tested.">Beta</span>
          </div>
          <p className="always-active-subtitle">Prevent deactivation or apply adaptive focus signaling for apps and borderless games.</p>
        </div>
        <div className="always-active-toolbar">
          <button className="ghost-button" type="button" disabled={busy !== null} onClick={() => void runAction('refresh windows', () => window.winUtils.alwaysActive.refreshWindows())} title="Refresh the running-window list.">
            Refresh
          </button>
          <button className="ghost-button" type="button" disabled={busy !== null || !state?.settings.enabled} onClick={() => void runAction('pause rules', () => window.winUtils.alwaysActive.pause(30), 'Always Active paused for 30 seconds.')} title="Temporarily stop enforcement so you can move around Windows normally.">
            Pause 30s
          </button>
          <button className={`toggle-button ${state?.settings.enabled ? '' : 'toggle-button--restore'}`} type="button" disabled={busy !== null} onClick={() => void runAction('toggle Always Active', () => window.winUtils.alwaysActive.setEnabled(!(state?.settings.enabled ?? false)), state?.settings.enabled ? 'Always Active disabled.' : 'Always Active enabled.')} title="Enable or disable all Always Active rules.">
            {state?.settings.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {message ? <div className="success-banner">{message}</div> : null}
      {state?.workerStatus.error ? <div className="always-active-warning">{state.workerStatus.error}</div> : null}

      <div className="always-active-stats">
        <AlwaysActiveStat label="Rules" value={state?.rules.length ?? 0} title="Saved apps that WinUtils should keep active." />
        <AlwaysActiveStat label="Windows" value={state?.windows.length ?? 0} title="Visible top-level windows currently detected." />
        <AlwaysActiveStat label="Managed" value={managedWindowCount} title="Detected windows matching saved Always Active rules." />
        <AlwaysActiveStat label="Active Now" value={activeRuleCount} title="Rules matched during the last enforcement pass." />
        <div className={`always-active-stat ${paused ? 'always-active-stat--warning' : ''}`} title="Current Always Active enforcement status.">
          <span>Status</span>
          <strong>{!state?.workerStatus.supported ? 'Unsupported' : paused ? 'Paused' : state?.settings.enabled ? 'On' : 'Off'}</strong>
        </div>
      </div>

      <div className="always-active-grid">
        <section className="always-active-panel">
          <div className="always-active-panel-header">
            <div>
              <p className="section-kicker">Rules</p>
              <h3>Selected Apps</h3>
              <p>{busy ? `Working: ${busy}...` : state?.settings.enabled ? 'Rules are ready.' : 'Rules are saved but disabled.'}</p>
            </div>
          </div>

          <div className="always-active-rule-list">
            {loading ? <div className="empty-state">Loading Always Active rules...</div> : null}
            {!loading && !state?.rules.length ? <div className="empty-state">No apps selected yet.</div> : null}
            {state?.rules.map((rule) => (
              <AlwaysActiveRuleRow
                key={rule.id}
                rule={rule}
                busy={busy !== null}
                active={state.workerStatus.lastAppliedRuleIds.includes(rule.id)}
                onToggle={() => runAction(rule.enabled ? 'disable rule' : 'enable rule', () => window.winUtils.alwaysActive.updateRule({ id: rule.id, enabled: !rule.enabled }), rule.enabled ? 'Rule disabled.' : 'Rule enabled.')}
                onMode={(mode) => setRuleMode(rule, mode)}
                onRestoreMinimized={(restoreMinimized) => runAction('update restore setting', () => window.winUtils.alwaysActive.updateRule({ id: rule.id, restoreMinimized }))}
                onDelete={() => runAction('delete rule', () => window.winUtils.alwaysActive.deleteRule(rule.id), 'Rule removed.')}
              />
            ))}
          </div>
        </section>

        <section className="always-active-panel">
          <div className="always-active-panel-header">
            <div>
              <p className="section-kicker">Discovery</p>
              <h3>Running Windows</h3>
              <p>{state?.foregroundWindow?.title ? `Foreground: ${state.foregroundWindow.title}` : 'Foreground window unavailable.'}</p>
            </div>
          </div>

          <div className="always-active-window-list">
            {loading ? <div className="empty-state">Scanning running windows...</div> : null}
            {!loading && !state?.windows.length ? <div className="empty-state">No visible app windows found.</div> : null}
            {state?.windows.map((appWindow) => (
              <AlwaysActiveWindowRow
                key={appWindow.id}
                window={appWindow}
                busy={busy !== null}
                onAdd={(mode) => runAction('add app rule', () => window.winUtils.alwaysActive.addRuleFromWindow(appWindow.id, mode), 'App added to Always Active.')}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function AlwaysActiveStat({ label, value, title }: { label: string; value: number; title: string }): ReactElement {
  return (
    <div className="always-active-stat" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AlwaysActiveRuleRow({ rule, busy, active, onToggle, onMode, onRestoreMinimized, onDelete }: {
  rule: AlwaysActiveRule;
  busy: boolean;
  active: boolean;
  onToggle: () => Promise<void>;
  onMode: (mode: AlwaysActiveMode) => Promise<void>;
  onRestoreMinimized: (restoreMinimized: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}): ReactElement {
  const identity = formatIdentity(rule);

  return (
    <article className={`always-active-rule ${rule.enabled ? '' : 'always-active-rule--disabled'} ${active ? 'always-active-rule--active' : ''}`}>
      <div className="always-active-rule-main">
        <div>
          <strong>{rule.label}</strong>
          <p className="always-active-rule-identity" title={identity}>{identity}</p>
        </div>
        <span className="always-active-pill">{active ? 'Matched' : rule.enabled ? 'Ready' : 'Off'}</span>
      </div>
      <div className="always-active-rule-controls">
        <select className="macro-select" value={rule.mode} onChange={(event) => void onMode(event.target.value as AlwaysActiveMode)} disabled={busy} title="Choose how strongly WinUtils should keep this app active.">
          {modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <div className="always-active-rule-actions">
          <label title="Restore this window before focus-lock mode brings it forward.">
            <input type="checkbox" checked={rule.restoreMinimized} disabled={busy} onChange={(event) => void onRestoreMinimized(event.target.checked)} />
            <span>Restore</span>
          </label>
          <button className="micro-button" type="button" disabled={busy} onClick={() => void onToggle()} title={rule.enabled ? 'Disable this rule.' : 'Enable this rule.'}>
            {rule.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="micro-button micro-button--danger" type="button" disabled={busy} onClick={() => void onDelete()} title="Remove this app from Always Active.">
            Remove
          </button>
        </div>
      </div>
      <div className="always-active-rule-meta">
        <span>{modeLabel(rule.mode)}</span>
        {rule.lastMatchedAt ? <span>Last matched {new Date(rule.lastMatchedAt).toLocaleTimeString()}</span> : null}
      </div>
    </article>
  );
}

function AlwaysActiveWindowRow({ window, busy, onAdd }: {
  window: AlwaysActiveWindow;
  busy: boolean;
  onAdd: (mode: AlwaysActiveMode) => Promise<void>;
}): ReactElement {
  const managed = window.ruleIds.length > 0;

  return (
    <article className={`always-active-window ${window.isForeground ? 'always-active-window--foreground' : ''}`}>
      <div className="always-active-window-main">
        <strong title={window.title}>{window.title || 'Untitled window'}</strong>
        <p title={window.processPath || window.processName}>{formatWindowProcess(window)}</p>
      </div>
      <div className="always-active-window-flags">
        {window.isForeground ? <span>Foreground</span> : null}
        {window.isMinimized ? <span>Minimized</span> : null}
        {managed ? <span>Managed</span> : null}
      </div>
      <div className="always-active-window-actions">
        <button className="micro-button" type="button" disabled={busy || managed} onClick={() => void onAdd('prevent-deactivation')} title={modeOptions[0].title}>
          Prevent
        </button>
        <button className="micro-button" type="button" disabled={busy || managed} onClick={() => void onAdd('active-signal')} title={modeOptions[2].title}>
          Signal
        </button>
        <button className="micro-button" type="button" disabled={busy || managed} onClick={() => void onAdd('game-keepalive')} title={modeOptions[1].title}>
          Game
        </button>
        <button className="micro-button" type="button" disabled={busy || managed} onClick={() => void onAdd('keep-foreground')} title={modeOptions[3].title}>
          Lock
        </button>
      </div>
    </article>
  );
}

function formatIdentity(rule: AlwaysActiveRule): string {
  if (rule.processPath) return rule.processPath;
  if (rule.processName) return rule.processName.endsWith('.exe') ? rule.processName : `${rule.processName}.exe`;
  return rule.title || 'Title match';
}

function formatWindowProcess(window: AlwaysActiveWindow): string {
  const name = window.processName ? (window.processName.endsWith('.exe') ? window.processName : `${window.processName}.exe`) : `PID ${window.processId}`;
  return window.processPath ? `${name} - ${window.processPath}` : name;
}

function modeLabel(mode: AlwaysActiveMode): string {
  return modeOptions.find((option) => option.value === mode)?.label ?? 'Signal Active';
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
