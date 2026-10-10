import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AutomationActionDefinition } from '../../shared/actions';
import type {
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerState,
  AutomationTriggerType,
} from '../../shared/automationTriggers';

const triggerTypes: Array<{ value: AutomationTriggerType; label: string }> = [
  { value: 'application-started', label: 'Application started' },
  { value: 'application-closed', label: 'Application closed' },
  { value: 'window-focused', label: 'Window focused' },
  { value: 'clipboard-changed', label: 'Clipboard changed' },
  { value: 'file-created', label: 'File created' },
  { value: 'file-modified', label: 'File modified' },
  { value: 'file-deleted', label: 'File deleted' },
  { value: 'monitor-connected', label: 'Monitor connected' },
  { value: 'network-connected', label: 'Network connected' },
  { value: 'windows-unlocked', label: 'Windows unlocked' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'winutils-started', label: 'WinUtils started' },
];

export function AutomationTriggersTab(): ReactElement {
  const [state, setState] = useState<AutomationTriggerState | null>(null);
  const [catalog, setCatalog] = useState<AutomationActionDefinition[]>([]);
  const [draft, setDraft] = useState<AutomationTriggerInput>(() => blankTrigger());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextState, actions] = await Promise.all([
        window.winUtils.triggers.getState(),
        window.winUtils.actions.list(),
      ]);
      setState(nextState);
      setCatalog(actions.filter(action => action.ownerId !== 'navigation'));
      setDraft(current => current.action.actionId || !actions.length
        ? current
        : { ...current, action: { actionId: actions[0].id, parameters: defaultParameters(actions[0]) } });
    } catch (reason) {
      setError(cleanError(reason));
    }
  }, []);

  useEffect(() => {
    void load();
    return window.winUtils.triggers.onChanged(() => void load());
  }, [load]);

  const selectedAction = useMemo(
    () => catalog.find(action => action.id === draft.action.actionId) ?? null,
    [catalog, draft.action.actionId],
  );

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.winUtils.triggers.upsert(draft));
      setDraft(blankTrigger(catalog[0]));
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.winUtils.triggers.delete(id));
      if (draft.id === id) setDraft(blankTrigger(catalog[0]));
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.winUtils.triggers.runNow(id));
    } catch (reason) {
      setError(cleanError(reason));
    } finally {
      setBusy(false);
    }
  };

  const edit = (trigger: AutomationTrigger): void => {
    setDraft({
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      type: trigger.type,
      matchValue: trigger.matchValue,
      intervalSeconds: trigger.intervalSeconds,
      cooldownSeconds: trigger.cooldownSeconds,
      concurrency: trigger.concurrency,
      action: trigger.action,
    });
  };

  const needsAppMonitor = state?.triggers.some(trigger => trigger.enabled
    && ['application-started', 'application-closed', 'window-focused'].includes(trigger.type));
  const monitorStarting = needsAppMonitor && !state?.workerRunning;
  const statusLabel = !state ? 'Loading' : monitorStarting ? 'Starting app monitor'
    : state.triggers.some(trigger => trigger.enabled) ? 'Automation ready' : 'No active triggers';

  return (
    <div className="automation-triggers module-shell">
      <header className="automation-triggers__header">
        <div>
          <p className="section-kicker">Automation</p>
          <h2>Triggers</h2>
          <p>Run any reusable action when Windows, applications, files, or the clipboard change.</p>
        </div>
        <span className={`status-pill ${monitorStarting ? 'status-pill--warning' : state?.triggers.some(trigger => trigger.enabled) ? 'status-pill--success' : ''}`}>
          {statusLabel}
        </span>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="automation-triggers__layout">
        <section className="automation-trigger-editor">
          <div className="automation-trigger-editor__title">
            <div>
              <p className="section-kicker">{draft.id ? 'Edit rule' : 'New rule'}</p>
              <h3>{draft.id ? draft.name : 'Create automation'}</h3>
            </div>
            {draft.id ? (
              <button type="button" className="secondary-button" onClick={() => setDraft(blankTrigger(catalog[0]))}>New</button>
            ) : null}
          </div>

          <label className="macro-label">Name</label>
          <input className="macro-input" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="My automation" />

          <div className="automation-trigger-editor__grid">
            <label>
              <span className="macro-label">When</span>
              <select className="macro-select" value={draft.type} onChange={event => setDraft(current => ({ ...current, type: event.target.value as AutomationTriggerType }))}>
                {triggerTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>
            {requiresMatch(draft.type) ? (
              <label>
                <span className="macro-label">{matchLabel(draft.type)}</span>
                <input className="macro-input" value={draft.matchValue} onChange={event => setDraft(current => ({ ...current, matchValue: event.target.value }))} placeholder={matchPlaceholder(draft.type)} />
              </label>
            ) : null}
            {draft.type === 'schedule' ? (
              <label>
                <span className="macro-label">Every (seconds)</span>
                <input type="number" min={5} className="macro-input" value={draft.intervalSeconds} onChange={event => setDraft(current => ({ ...current, intervalSeconds: Number(event.target.value) }))} />
              </label>
            ) : null}
            <label>
              <span className="macro-label">Cooldown (seconds)</span>
              <input type="number" min={0} className="macro-input" value={draft.cooldownSeconds} onChange={event => setDraft(current => ({ ...current, cooldownSeconds: Number(event.target.value) }))} />
            </label>
            <label>
              <span className="macro-label">While already running</span>
              <select className="macro-select" value={draft.concurrency} onChange={event => setDraft(current => ({ ...current, concurrency: event.target.value as AutomationTriggerInput['concurrency'] }))}>
                <option value="skip">Skip new event</option>
                <option value="queue-one">Queue one run</option>
              </select>
            </label>
          </div>

          <label className="macro-check-label">
            <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} />
            <span>Enabled</span>
          </label>

          <div className="automation-trigger-action">
            <label className="macro-label">Run action</label>
            <select
              className="macro-select"
              value={draft.action.actionId}
              onChange={event => {
                const definition = catalog.find(action => action.id === event.target.value);
                setDraft(current => ({
                  ...current,
                  action: {
                    actionId: event.target.value,
                    parameters: definition ? defaultParameters(definition) : {},
                  },
                }));
              }}
            >
              <option value="">Choose an action...</option>
              {catalog.map(action => <option key={action.id} value={action.id}>{action.ownerLabel} / {action.label}</option>)}
            </select>
            {selectedAction ? <p>{selectedAction.description}</p> : null}
            {selectedAction?.parameters?.map(parameter => (
              <label key={parameter.id}>
                <span className="macro-label">{parameter.label}{parameter.required ? ' *' : ''}</span>
                {parameter.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(draft.action.parameters?.[parameter.id])}
                    onChange={event => setActionParameter(setDraft, parameter.id, event.target.checked)}
                  />
                ) : parameter.type === 'select' ? (
                  <select className="macro-select" value={String(draft.action.parameters?.[parameter.id] ?? '')} onChange={event => setActionParameter(setDraft, parameter.id, event.target.value)}>
                    {parameter.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : parameter.multiline ? (
                  <textarea className="macro-textarea" rows={3} value={String(draft.action.parameters?.[parameter.id] ?? '')} onChange={event => setActionParameter(setDraft, parameter.id, event.target.value)} />
                ) : (
                  <input
                    className="macro-input"
                    type={parameter.type === 'number' ? 'number' : 'text'}
                    min={parameter.min}
                    max={parameter.max}
                    value={String(draft.action.parameters?.[parameter.id] ?? '')}
                    placeholder={parameter.placeholder}
                    onChange={event => setActionParameter(setDraft, parameter.id, parameter.type === 'number' ? Number(event.target.value) : event.target.value)}
                  />
                )}
              </label>
            ))}
          </div>

          <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
            {draft.id ? 'Save changes' : 'Create trigger'}
          </button>
        </section>

        <section className="automation-trigger-list">
          <div className="automation-trigger-list__heading">
            <div>
              <p className="section-kicker">Rules</p>
              <h3>{state?.triggers.length ?? 0} configured</h3>
            </div>
            <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>Refresh</button>
          </div>
          {state?.triggers.map(trigger => (
            <article className="automation-trigger-item" key={trigger.id}>
              <div className="automation-trigger-item__summary">
                <span className={`status-dot ${trigger.enabled ? 'status-dot--active' : ''}`} />
                <div>
                  <strong>{trigger.name}</strong>
                  <small>{triggerTypes.find(type => type.value === trigger.type)?.label}{trigger.matchValue ? ` / ${trigger.matchValue}` : ''}</small>
                </div>
                <span className="status-pill">{trigger.running ? 'Running' : trigger.queued ? 'Queued' : `${trigger.runCount} runs`}</span>
              </div>
              <p>{trigger.action.actionId}</p>
              {trigger.lastError ? <div className="automation-trigger-item__error">{trigger.lastError}</div> : null}
              <div className="automation-trigger-item__footer">
                <small>Last run: {trigger.lastRunAt ? new Date(trigger.lastRunAt).toLocaleString() : 'never'}</small>
                <div>
                  <button type="button" className="micro-button" disabled={busy || trigger.running} onClick={() => void runNow(trigger.id)}>Run</button>
                  <button type="button" className="micro-button" disabled={busy} onClick={() => edit(trigger)}>Edit</button>
                  <button type="button" className="micro-button micro-button--danger" disabled={busy || trigger.running} onClick={() => void remove(trigger.id)}>Delete</button>
                </div>
              </div>
            </article>
          ))}
          {!state?.triggers.length ? <div className="empty-state">No automation triggers yet.</div> : null}
        </section>
      </div>
    </div>
  );
}

function blankTrigger(action?: AutomationActionDefinition): AutomationTriggerInput {
  return {
    name: '',
    enabled: true,
    type: 'application-started',
    matchValue: '',
    intervalSeconds: 60,
    cooldownSeconds: 5,
    concurrency: 'skip',
    action: {
      actionId: action?.id ?? '',
      parameters: action ? defaultParameters(action) : {},
    },
  };
}

function defaultParameters(action: AutomationActionDefinition): Record<string, unknown> {
  return Object.fromEntries((action.parameters ?? [])
    .filter(parameter => parameter.defaultValue !== undefined)
    .map(parameter => [parameter.id, parameter.defaultValue]));
}

function setActionParameter(
  setDraft: React.Dispatch<React.SetStateAction<AutomationTriggerInput>>,
  id: string,
  value: unknown,
): void {
  setDraft(current => ({
    ...current,
    action: {
      ...current.action,
      parameters: { ...current.action.parameters, [id]: value },
    },
  }));
}

function requiresMatch(type: AutomationTriggerType): boolean {
  return ['application-started', 'application-closed', 'window-focused', 'file-created', 'file-modified', 'file-deleted'].includes(type);
}

function matchLabel(type: AutomationTriggerType): string {
  if (type.startsWith('file-')) return 'File path';
  if (type === 'window-focused') return 'Process or title contains';
  return 'Process name contains';
}

function matchPlaceholder(type: AutomationTriggerType): string {
  if (type.startsWith('file-')) return 'C:\\Path\\file.txt';
  if (type === 'window-focused') return 'Discord or a window title';
  return 'Discord.exe';
}

function cleanError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '');
}
