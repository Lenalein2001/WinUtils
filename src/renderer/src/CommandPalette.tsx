import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AutomationActionDefinition, AutomationActionParameterDefinition } from '../../shared/actions';

export function CommandPalette(): ReactElement {
  const [actions, setActions] = useState<AutomationActionDefinition[]>([]);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AutomationActionDefinition | null>(null);
  const [parameters, setParameters] = useState<Record<string, string | number | boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const loadActions = useCallback(async (): Promise<void> => {
    try {
      setActions(await window.winUtils.actions.list());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const directCommand = useMemo(() => parseDirectCommand(query, actions), [actions, query]);

  const results = useMemo(() => {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = actions
      .filter(action => action.id !== 'commandPalette.open')
      .filter(action => action.id !== directCommand?.action.id)
      .filter(action => {
        if (tokens.length === 0) return true;
        const text = [
          action.label,
          action.description,
          action.ownerLabel,
          action.category,
          ...action.keywords,
        ].join(' ').toLowerCase();
        return tokens.every(token => text.includes(token));
      })
      .slice(0, directCommand ? 39 : 40);
    return directCommand ? [directCommand.action, ...matches] : matches;
  }, [actions, directCommand, query]);

  const resetAndFocus = useCallback((): void => {
    setQuery('');
    setSelectedIndex(0);
    setError(null);
    setBusy(false);
    setPendingAction(null);
    setParameters({});
    void loadActions();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [loadActions]);

  useEffect(() => {
    resetAndFocus();
    return window.winUtils.commandPalette.onOpenRequested(resetAndFocus);
  }, [resetAndFocus]);

  useEffect(() => {
    setSelectedIndex(index => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-action-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const execute = useCallback(async (
    action: AutomationActionDefinition,
    actionParameters: Record<string, string | number | boolean> = {},
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.winUtils.commandPalette.hide();
      const result = await window.winUtils.actions.execute({ actionId: action.id, parameters: actionParameters });
      if (!result.ok) {
        await window.winUtils.actions.execute({ actionId: 'commandPalette.open' });
        setError(result.error ?? `${action.label} failed.`);
        setBusy(false);
      }
    } catch (reason) {
      await window.winUtils.actions.execute({ actionId: 'commandPalette.open' });
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }, [busy]);

  const chooseAction = (action: AutomationActionDefinition): void => {
    if (directCommand?.action.id === action.id) {
      if (!action.dangerous) {
        void execute(action, directCommand.parameters);
        return;
      }
      setParameters(directCommand.parameters);
      setPendingAction(action);
      setError(null);
      return;
    }
    if ((action.parameters?.length ?? 0) === 0) {
      void execute(action);
      return;
    }
    setParameters(Object.fromEntries((action.parameters ?? [])
      .filter(parameter => parameter.defaultValue !== undefined)
      .map(parameter => [parameter.id, parameter.defaultValue as string | number | boolean])));
    setPendingAction(action);
    setError(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex(index => Math.min(index + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && !pendingAction && results[selectedIndex]) {
      event.preventDefault();
      chooseAction(results[selectedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void window.winUtils.commandPalette.hide();
    }
  };

  return (
    <main className="command-palette" onKeyDown={handleKeyDown}>
      {pendingAction ? (
        <header className="command-palette__action-header">
          <button type="button" onClick={() => setPendingAction(null)} aria-label="Back to action search">&lt;</button>
          <div>
            <strong>{pendingAction.label}</strong>
            <small>{pendingAction.description}</small>
          </div>
          <span>{pendingAction.ownerLabel}</span>
        </header>
      ) : (
        <label className="command-palette__search">
          <span aria-hidden="true">&gt;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            autoFocus
            placeholder="Search actions or type: mute discord, volume spotify 40..."
          />
          <kbd>Esc</kbd>
        </label>
      )}

      <div className="command-palette__body">
        {error ? <div className="command-palette__error">{error}</div> : null}
        {pendingAction ? (
          <div className="command-palette__parameters">
            {pendingAction.dangerous ? (
              <div className="command-palette__warning">This action can terminate processes or run commands. Review every value before running it.</div>
            ) : null}
            {pendingAction.parameters?.map(parameter => (
              <label key={parameter.id} className="command-palette-field">
                <span>{parameter.label}{parameter.required ? ' *' : ''}</span>
                <CommandParameterInput
                  parameter={parameter}
                  value={parameters[parameter.id] ?? parameter.defaultValue ?? ''}
                  onChange={value => setParameters(current => ({ ...current, [parameter.id]: value }))}
                />
                {parameter.description ? <small>{parameter.description}</small> : null}
              </label>
            ))}
          </div>
        ) : <div className="command-palette__results" role="listbox" aria-label="WinUtils actions">
          {results.length === 0 ? (
            <div className="command-palette__empty">No actions match "{query}".</div>
          ) : results.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="option"
              aria-selected={selectedIndex === index}
              data-action-index={index}
              className={`command-palette-item${selectedIndex === index ? ' command-palette-item--selected' : ''}`}
              disabled={busy}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => chooseAction(action)}
            >
              <span className="command-palette-item__icon">{actionIcon(action)}</span>
              <span className="command-palette-item__copy">
                <strong>{directCommand?.action.id === action.id ? directCommand.label : action.label}</strong>
                <small>{action.description}</small>
              </span>
              <span className="command-palette-item__owner">{directCommand?.action.id === action.id ? 'Command' : action.ownerLabel}</span>
            </button>
          ))}
        </div>}
      </div>

      <footer className="command-palette__footer">
        {pendingAction ? (
          <>
            <button type="button" className="command-palette__cancel" onClick={() => setPendingAction(null)}>Cancel</button>
            <button
              type="button"
              className={`command-palette__run${pendingAction.dangerous ? ' command-palette__run--danger' : ''}`}
              disabled={busy}
              onClick={() => void execute(pendingAction, parameters)}
            >
              {busy ? 'Running...' : 'Run action'}
            </button>
          </>
        ) : (
          <>
            <span>{results.length} {results.length === 1 ? 'action' : 'actions'}</span>
            <span><kbd>Up</kbd><kbd>Dn</kbd> Navigate</span>
            <span><kbd>Enter</kbd> Select</span>
          </>
        )}
      </footer>
    </main>
  );
}

function CommandParameterInput({
  parameter,
  value,
  onChange,
}: {
  parameter: AutomationActionParameterDefinition;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}): ReactElement {
  if (parameter.type === 'boolean') {
    return <input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />;
  }
  if (parameter.type === 'select') {
    return (
      <select value={String(value)} onChange={event => onChange(event.target.value)}>
        {parameter.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (parameter.multiline) {
    return (
      <textarea
        rows={4}
        value={String(value)}
        placeholder={parameter.placeholder}
        onChange={event => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      type={parameter.type === 'number' ? 'number' : 'text'}
      value={String(value)}
      min={parameter.min}
      max={parameter.max}
      placeholder={parameter.placeholder}
      onChange={event => onChange(parameter.type === 'number' ? Number(event.target.value) : event.target.value)}
    />
  );
}

function actionIcon(action: AutomationActionDefinition): string {
  if (action.category === 'macro') return 'M';
  if (action.category === 'clipboard') return 'C';
  if (action.category === 'application') return 'A';
  if (action.category === 'window') return 'W';
  if (action.category === 'audio') return 'V';
  if (action.category === 'file') return 'F';
  return '>';
}

interface DirectCommand {
  action: AutomationActionDefinition;
  label: string;
  parameters: Record<string, string | number | boolean>;
}

function parseDirectCommand(query: string, actions: AutomationActionDefinition[]): DirectCommand | null {
  const parts = tokenizeCommand(query);
  if (parts.length < 2) return null;
  const verb = parts[0].toLowerCase();
  const find = (id: string): AutomationActionDefinition | null => actions.find(action => action.id === id) ?? null;
  const make = (
    actionId: string,
    label: string,
    parameters: Record<string, string | number | boolean>,
  ): DirectCommand | null => {
    const action = find(actionId);
    return action ? { action, label, parameters } : null;
  };

  if (verb === 'mute' || verb === 'unmute') {
    return make('audio.setApplicationMuted', `${verb === 'mute' ? 'Mute' : 'Unmute'} ${parts.slice(1).join(' ')}`, {
      processName: parts.slice(1).join(' '),
      muted: verb === 'mute',
    });
  }
  if (verb === 'volume' && parts.length >= 3) {
    const firstNumber = Number(parts[1]);
    const lastNumber = Number(parts[parts.length - 1]);
    const volume = Number.isFinite(firstNumber) ? firstNumber : lastNumber;
    const processName = Number.isFinite(firstNumber) ? parts.slice(2).join(' ') : parts.slice(1, -1).join(' ');
    if (volume >= 0 && volume <= 100 && processName) {
      return make('audio.setApplicationVolume', `Set ${processName} volume to ${volume}%`, { processName, volume });
    }
  }
  if (verb === 'kill' || verb === 'close' || verb === 'focus' || verb === 'wait') {
    const processName = parts.slice(1).join(' ');
    const actionId = verb === 'kill'
      ? 'process.kill'
      : verb === 'close'
        ? 'application.close'
        : verb === 'focus'
          ? 'window.focus'
          : 'application.wait';
    return make(actionId, `${verb[0].toUpperCase()}${verb.slice(1)} ${processName}`, {
      processName,
      ...(verb === 'focus' ? { title: '' } : {}),
      ...(verb === 'wait' ? { timeoutSeconds: 30 } : {}),
    });
  }
  if (verb === 'notify') {
    return make('system.notification', `Show notification: ${parts.slice(1).join(' ')}`, {
      title: 'WinUtils',
      message: parts.slice(1).join(' '),
    });
  }
  if (verb === 'clip' || verb === 'clipboard') {
    return make('clipboard.setText', 'Set clipboard text', { text: parts.slice(1).join(' ') });
  }
  if (verb === 'url') {
    return make('system.openUrl', `Open ${parts[1]}`, { url: parts[1] });
  }
  if (verb === 'layout') {
    const name = parts.slice(1).join(' ').toLowerCase();
    const action = actions.find(item => item.ownerId === 'window-layouts' && item.label.toLowerCase().includes(name));
    return action ? { action, label: `Apply layout ${parts.slice(1).join(' ')}`, parameters: {} } : null;
  }
  if (verb === 'window' && parts.length >= 4) {
    const monitorIndex = parts.findIndex(part => part.toLowerCase() === 'monitor');
    const monitor = monitorIndex >= 0 ? Number(parts[monitorIndex + 1]) : 1;
    const processName = parts[1];
    const presetParts = parts.slice(2, monitorIndex >= 0 ? monitorIndex : undefined);
    const preset = normalizePreset(presetParts.join('-'));
    if (preset && Number.isFinite(monitor) && monitor >= 1) {
      return make('window.applyPreset', `Move ${processName} to monitor ${monitor} / ${preset.replace(/-/g, ' ')}`, {
        processName,
        monitor,
        preset,
      });
    }
  }
  return null;
}

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.trim().matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizePreset(value: string): string | null {
  const normalized = value.toLowerCase().replace(/\s+/g, '-');
  const aliases: Record<string, string> = {
    left: 'left-half',
    right: 'right-half',
    full: 'fullscreen',
    fullscreen: 'fullscreen',
    center: 'center',
    'left-half': 'left-half',
    'right-half': 'right-half',
    'top-left': 'top-left',
    'top-right': 'top-right',
    'bottom-left': 'bottom-left',
    'bottom-right': 'bottom-right',
  };
  return aliases[normalized] ?? null;
}
