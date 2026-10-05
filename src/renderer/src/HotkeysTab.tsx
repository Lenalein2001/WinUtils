import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { HotkeyBinding, HotkeyConflict, HotkeyState } from '../../shared/hotkeys';
import { HotkeyInput } from './MacrosTab';

function statusLabel(binding: HotkeyBinding): string {
  if (!binding.available) return 'Macro disabled';
  if (binding.status === 'active') return `Active · ${binding.backend}`;
  if (binding.status === 'internal-conflict') return 'Conflict';
  if (binding.status === 'os-registration-failed') return 'Unavailable in Windows';
  return 'Disabled';
}

function HotkeyRow({
  binding,
  onUpdated,
  onDeleted,
}: {
  binding: HotkeyBinding;
  onUpdated: (state: HotkeyState) => void;
  onDeleted?: (state: HotkeyState) => void;
}): ReactElement {
  const [draft, setDraft] = useState(binding.hotkey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<HotkeyConflict[]>([]);

  useEffect(() => {
    setDraft(binding.hotkey);
  }, [binding.hotkey]);

  const update = async (enabled: boolean, replaceConflicts = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.winUtils.hotkeys.update({
        bindingId: binding.id,
        hotkey: draft,
        enabled,
        replaceConflicts,
      });
      onUpdated(result.state);
      if (!result.ok) {
        setError(result.error ?? 'The hotkey could not be updated.');
        setPendingConflicts(result.conflicts);
        return;
      }
      setPendingConflicts([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPendingConflicts([]);
    } finally {
      setBusy(false);
    }
  };

  const dirty = draft !== binding.hotkey;

  return (
    <div className={`hotkey-row hotkey-row--${binding.status}`}>
      <div className="hotkey-row__identity">
        <strong>{binding.label}</strong>
        <span>{binding.description}</span>
        <small>{binding.source === 'macro' ? 'Macro binding' : binding.source === 'action' ? 'Action binding' : 'Feature binding'}</small>
      </div>
      <div className="hotkey-row__editor">
        <HotkeyInput
          value={draft}
          onChange={setDraft}
          placeholder="Click and press keys"
          title={`Change the hotkey for ${binding.label}.`}
          allowModifierKeys
          allowNonAsciiKeys={false}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !binding.editable || !draft || (!dirty && binding.enabled)}
          onClick={() => void update(true)}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="hotkey-row__status">
        <span className={`hotkey-status hotkey-status--${binding.status}`}>{statusLabel(binding)}</span>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={binding.enabled}
            disabled={busy || !binding.editable || !binding.available}
            onChange={(event) => void update(event.target.checked)}
          />
          <span>Enabled</span>
        </label>
        {binding.source === 'action' ? (
          <button
            type="button"
            className="micro-button micro-button--danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.winUtils.hotkeys.deleteActionBinding(binding.id)
                .then(next => onDeleted?.(next))
                .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => setBusy(false));
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="hotkey-row__error">
          <span>{error}</span>
          {pendingConflicts.length > 0 ? (
            <>
              <small>{pendingConflicts.flatMap(conflict => conflict.labels).join(' · ')}</small>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void update(true, true)}>
                Replace existing binding
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HotkeysTab(): ReactElement {
  const [state, setState] = useState<HotkeyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState('');
  const [actionHotkey, setActionHotkey] = useState('');
  const [adding, setAdding] = useState(false);

  const refresh = (): void => {
    void window.winUtils.hotkeys.getState()
      .then(setState)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  useEffect(() => {
    refresh();
    return window.winUtils.hotkeys.onChanged(refresh);
  }, []);

  const groups = useMemo(() => {
    const next = new Map<string, HotkeyBinding[]>();
    for (const binding of state?.bindings ?? []) {
      const group = next.get(binding.ownerLabel) ?? [];
      group.push(binding);
      next.set(binding.ownerLabel, group);
    }
    return [...next.entries()];
  }, [state]);

  const activeCount = state?.bindings.filter(binding => binding.status === 'active').length ?? 0;
  const issueCount = state?.bindings.filter(binding => (
    binding.status === 'internal-conflict' || binding.status === 'os-registration-failed'
  )).length ?? 0;
  const bindableActions = state?.actions.filter(action => (
    !(action.parameters ?? []).some(parameter => parameter.required && parameter.defaultValue === undefined)
  )) ?? [];

  const addActionBinding = async (): Promise<void> => {
    setAdding(true);
    setError(null);
    try {
      const result = await window.winUtils.hotkeys.createActionBinding({ actionId, hotkey: actionHotkey });
      setState(result.state);
      if (!result.ok) {
        setError(result.error ?? 'The action hotkey could not be created.');
        return;
      }
      setActionId('');
      setActionHotkey('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="hotkeys-tab">
      <div className="hotkeys-summary">
        <div><strong>{state?.bindings.length ?? 0}</strong><span>Bindings</span></div>
        <div><strong>{activeCount}</strong><span>Active</span></div>
        <div><strong>{issueCount}</strong><span>Needs attention</span></div>
        <div><strong>{state?.actions.length ?? 0}</strong><span>Registered actions</span></div>
      </div>

      <div className="info-banner">
        WinUtils registers feature, macro, and reusable action shortcuts through one manager. Conflicts are blocked before Windows registration.
      </div>

      <section className="hotkey-action-create">
        <div>
          <p className="section-kicker">Reusable actions</p>
          <h3>Bind another action</h3>
          <span>Actions that need no additional parameters can run directly from a global shortcut.</span>
        </div>
        <select className="macro-select" value={actionId} onChange={event => setActionId(event.target.value)}>
          <option value="">Choose an action...</option>
          {bindableActions.map(action => (
            <option key={action.id} value={action.id}>{action.ownerLabel} / {action.label}</option>
          ))}
        </select>
        <HotkeyInput
          value={actionHotkey}
          onChange={setActionHotkey}
          placeholder="Click and press keys"
          title="Choose the global shortcut for this action."
          allowModifierKeys
          allowNonAsciiKeys={false}
        />
        <button type="button" className="primary-button" disabled={adding || !actionId || !actionHotkey} onClick={() => void addActionBinding()}>
          {adding ? 'Adding...' : 'Add hotkey'}
        </button>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}
      {!state ? <div className="empty-state">Loading hotkeys…</div> : null}

      {groups.map(([owner, bindings]) => (
        <section className="hotkey-group" key={owner}>
          <div className="hotkey-group__header">
            <div>
              <p className="section-kicker">Owner</p>
              <h3>{owner}</h3>
            </div>
            <span>{bindings.length} {bindings.length === 1 ? 'binding' : 'bindings'}</span>
          </div>
          <div className="hotkey-list">
            {bindings.map(binding => (
              <HotkeyRow key={binding.id} binding={binding} onUpdated={setState} onDeleted={setState} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
