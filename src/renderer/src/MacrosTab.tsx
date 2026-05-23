import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CommandAction,
  DelayAction,
  KeyboardAction,
  LaunchAction,
  Macro,
  MacroAction,
  MacroFolder,
  MacroProfile,
  MacroState,
  MouseAction,
  TextAction,
} from '../../shared/macro';

// ─── Helpers ──────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function blankMacro(name = 'New Macro'): Macro {
  return { id: newId(), name, hotkey: '', actions: [], enabled: true };
}

function blankFolder(name = 'New Folder'): MacroFolder {
  return { id: newId(), name, macros: [], isExpanded: true };
}

function captureKeyName(event: React.KeyboardEvent<HTMLInputElement>): string {
  const numpadKey = captureNumpadKeyName(event.code);
  if (numpadKey) return numpadKey;

  if (event.key === 'Enter') return 'Enter';
  if (event.key === ' ') return 'Space';
  if (event.key.length === 1) return event.key.toUpperCase();

  return event.key;
}

function captureNumpadKeyName(code: string): string | null {
  const digit = code.match(/^Numpad([0-9])$/)?.[1];
  if (digit) return `Num${digit}`;

  switch (code) {
    case 'NumpadDecimal': return 'NumDec';
    case 'NumpadAdd': return 'NumAdd';
    case 'NumpadSubtract': return 'NumSub';
    case 'NumpadMultiply': return 'NumMult';
    case 'NumpadDivide': return 'NumDiv';
    case 'NumpadEnter': return 'Enter';
    default: return null;
  }
}

function actionLabel(a: MacroAction): string {
  switch (a.type) {
    case 'delay': return `Delay ${a.milliseconds} ms`;
    case 'keyboard': return `${a.pressType} ${a.key}`;
    case 'mouse': return `${a.button} ${a.actionType}${a.x !== undefined ? ` (${a.x},${a.y})` : ''}`;
    case 'launch': return `Launch ${a.path.split(/[\\/]/).pop() ?? a.path}`;
    case 'command': return `Run: ${a.command.slice(0, 40)}`;
    case 'text': return `Type: ${a.text.slice(0, 30)}`;
    default: return '';
  }
}

const macroActionDescriptions: Record<MacroAction['type'], string> = {
  delay: 'Wait for a number of milliseconds before running the next action.',
  keyboard: 'Send a keyboard key or key combination.',
  mouse: 'Click, hold, release, or move the mouse.',
  launch: 'Start an app or executable file.',
  command: 'Run a PowerShell command.',
  text: 'Type text into the focused window.',
};

// ─── Hotkey capture input ─────────────────────────────────────────────────

function HotkeyInput({
  value,
  onChange,
  placeholder = 'Click and press keys…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const key = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return;

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');

    parts.push(captureKeyName(e));

    onChange(parts.join('+'));
    setCapturing(false);
  };

  return (
    <input
      className={`macro-input${capturing ? ' macro-input--capturing' : ''}`}
      value={capturing ? '' : value}
      placeholder={capturing ? 'Press keys…' : placeholder}
      readOnly={!capturing}
      onFocus={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={capturing ? handleKeyDown : undefined}
      onChange={() => {}}
      title="Click here, then press the key combination that should trigger this macro globally."
    />
  );
}

// ─── Action editor ────────────────────────────────────────────────────────

function ActionEditor({
  action,
  onChange,
  onDelete,
}: {
  action: MacroAction;
  onChange: (a: MacroAction) => void;
  onDelete: () => void;
}): ReactElement {
  const patch = (updates: Partial<MacroAction>) =>
    onChange({ ...action, ...updates } as MacroAction);

  return (
    <div className={`action-row${action.enabled ? '' : ' action-row--disabled'}`}>
      <div className="action-row-header">
        <span className="action-type-badge" title={macroActionDescriptions[action.type]}>{action.type}</span>
        <div className="action-row-controls">
          <button
            type="button"
            className="micro-button"
            onClick={() => patch({ enabled: !action.enabled })}
            title={action.enabled ? 'Disable this action without deleting it.' : 'Enable this action again.'}
          >
            {action.enabled ? '⏸' : '▶'}
          </button>
          <button type="button" className="micro-button micro-button--danger" onClick={onDelete} title="Delete this action from the macro.">
            ✕
          </button>
        </div>
      </div>

      {action.type === 'delay' && (
        <div className="action-fields">
          <label className="macro-label">Delay (ms)</label>
          <input
            type="number"
            className="macro-input"
            value={(action as DelayAction).milliseconds}
            min={0}
            onChange={e => patch({ milliseconds: Number(e.target.value) })}
            title="How long to pause before continuing to the next action."
          />
        </div>
      )}

      {action.type === 'keyboard' && (
        <div className="action-fields">
          <label className="macro-label">Key</label>
          <input
            className="macro-input"
            value={(action as KeyboardAction).key}
            placeholder="e.g. Ctrl+C"
            onChange={e => patch({ key: e.target.value })}
            title="Key or key combination to send, such as Ctrl+C or Enter."
          />
          <label className="macro-label">Type</label>
          <select
            className="macro-select"
            value={(action as KeyboardAction).pressType}
            onChange={e => patch({ pressType: e.target.value as KeyboardAction['pressType'] })}
            title="Choose whether to press and release the key, hold it down, or release it."
          >
            <option value="press">Press (down+up)</option>
            <option value="down">Key Down</option>
            <option value="up">Key Up</option>
          </select>
        </div>
      )}

      {action.type === 'mouse' && (
        <div className="action-fields">
          <label className="macro-label">Button</label>
          <select
            className="macro-select"
            value={(action as MouseAction).button}
            onChange={e => patch({ button: e.target.value as MouseAction['button'] })}
            title="Mouse button used by this action."
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="middle">Middle</option>
          </select>
          <label className="macro-label">Action</label>
          <select
            className="macro-select"
            value={(action as MouseAction).actionType}
            onChange={e => patch({ actionType: e.target.value as MouseAction['actionType'] })}
            title="Mouse operation to run. Down and Up are useful for drag-style macros."
          >
            <option value="click">Click</option>
            <option value="double-click">Double Click</option>
            <option value="down">Down</option>
            <option value="up">Up</option>
            <option value="move">Move to position</option>
          </select>
          {(action as MouseAction).actionType === 'move' && (
            <>
              <label className="macro-label">X</label>
              <input
                type="number"
                className="macro-input macro-input--half"
                value={(action as MouseAction).x ?? ''}
                onChange={e => patch({ x: Number(e.target.value) })}
                title="Screen X coordinate for mouse movement."
              />
              <label className="macro-label">Y</label>
              <input
                type="number"
                className="macro-input macro-input--half"
                value={(action as MouseAction).y ?? ''}
                onChange={e => patch({ y: Number(e.target.value) })}
                title="Screen Y coordinate for mouse movement."
              />
            </>
          )}
        </div>
      )}

      {action.type === 'launch' && (
        <div className="action-fields">
          <label className="macro-label">Path</label>
          <input
            className="macro-input"
            value={(action as LaunchAction).path}
            placeholder="C:\path\to\app.exe"
            onChange={e => patch({ path: e.target.value })}
            title="Full path to the app or executable to launch."
          />
          <label className="macro-label">Arguments</label>
          <input
            className="macro-input"
            value={(action as LaunchAction).arguments}
            placeholder="Optional arguments"
            onChange={e => patch({ arguments: e.target.value })}
            title="Optional command-line arguments passed to the launched app."
          />
        </div>
      )}

      {action.type === 'command' && (
        <div className="action-fields">
          <label className="macro-label">PowerShell command</label>
          <textarea
            className="macro-textarea"
            value={(action as CommandAction).command}
            onChange={e => patch({ command: e.target.value })}
            rows={3}
            title="PowerShell command to run when this action executes."
          />
          <label className="macro-label">Working directory</label>
          <input
            className="macro-input"
            value={(action as CommandAction).workingDirectory}
            placeholder="Optional"
            onChange={e => patch({ workingDirectory: e.target.value })}
            title="Optional folder where the PowerShell command should run."
          />
        </div>
      )}

      {action.type === 'text' && (
        <div className="action-fields">
          <label className="macro-label">Text to type</label>
          <textarea
            className="macro-textarea"
            value={(action as TextAction).text}
            onChange={e => patch({ text: e.target.value })}
            rows={3}
            title="Text that will be typed into the currently focused window."
          />
        </div>
      )}
    </div>
  );
}

// ─── Main MacrosTab ───────────────────────────────────────────────────────

export function MacrosTab(): ReactElement {
  const [state, setState] = useState<MacroState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMacroId, setSelectedMacroId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [busyOp, setBusyOp] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileInput, setNewProfileInput] = useState('');
  const [activeApps, setActiveApps] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load state
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await window.winUtils.macros.getState();
      setState(s);
      setExpandedFolders(prev => {
        const next = new Set(prev);
        s.activeProfile.folders.forEach(f => { if (f.isExpanded) next.add(f.id); });
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load macros.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Push notification: main process auto-switched the active profile
  useEffect(() => {
    const off = window.winUtils.macros.onProfileChanged(s => setState(s));
    return off;
  }, []);

  const loadActiveApps = useCallback(async () => {
    setAppsLoading(true);
    try {
      const apps = await window.winUtils.macros.getActiveApps();
      setActiveApps(apps);
    } catch { /* ignore */ } finally {
      setAppsLoading(false);
    }
  }, []);

  useEffect(() => { void loadActiveApps(); }, [loadActiveApps]);

  useEffect(() => {
    appsPollRef.current = setInterval(() => {
      void window.winUtils.macros.getActiveApps().then(setActiveApps).catch(() => undefined);
    }, 3000);
    return () => {
      if (appsPollRef.current) clearInterval(appsPollRef.current);
    };
  }, []);

  const api = window.winUtils.macros;

  const call = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusyOp(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
      return null;
    } finally {
      setBusyOp(false);
    }
  };

  const update = async (fn: () => Promise<MacroState>): Promise<void> => {
    const s = await call(fn);
    if (s) setState(s);
  };

  // Get selected macro
  const profile: MacroProfile | undefined = state?.activeProfile;
  const allMacros: Macro[] = profile
    ? [...profile.macros, ...profile.folders.flatMap((f: MacroFolder) => f.macros)]
    : [];
  const selectedMacro = allMacros.find(m => m.id === selectedMacroId) ?? null;

  // Save macro after debounced edit
  const saveMacro = useCallback((macro: Macro) => {
    setState(prev => {
      if (!prev) return prev;
      const p = prev.activeProfile;
      const patchProfile = (prof: MacroProfile): MacroProfile => ({
        ...prof,
        macros: prof.macros.map((m: Macro) => m.id === macro.id ? macro : m),
        folders: prof.folders.map((f: MacroFolder) => ({
          ...f,
          macros: f.macros.map((m: Macro) => m.id === macro.id ? macro : m),
        })),
      });
      return {
        ...prev,
        activeProfile: patchProfile(p),
        allMacros: prev.allMacros.map((m: Macro) => m.id === macro.id ? macro : m),
      };
    });
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      void api.upsertMacro(macro).then(s => setState(s)).catch(() => {});
    }, 600);
  }, [api]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) return <div className="empty-state">Loading macros…</div>;

  return (
    <div className="macros-layout">
      {/* ── Left panel: profile + macro tree ── */}
      <div className="macros-sidebar">

        {/* Profile bar */}
        <div className="macros-profile-bar">
          {addingProfile ? (
            <>
              <input
                className="macro-input"
                style={{ flex: 1 }}
                autoFocus
                placeholder="Profile name…"
                value={newProfileInput}
                onChange={e => setNewProfileInput(e.target.value)}
                title="Name for the new macro profile. Profiles can switch based on focused apps."
                onKeyDown={e => {
                  if (e.key === 'Enter' && newProfileInput.trim()) {
                    void update(() => api.addProfile(newProfileInput.trim())).then(() => {
                      setNewProfileInput(''); setAddingProfile(false);
                    });
                  }
                  if (e.key === 'Escape') { setNewProfileInput(''); setAddingProfile(false); }
                }}
              />
              <button
                type="button"
                className="micro-button"
                disabled={!newProfileInput.trim() || busyOp}
                title="Create this macro profile."
                onClick={() => {
                  if (!newProfileInput.trim()) return;
                  void update(() => api.addProfile(newProfileInput.trim())).then(() => {
                    setNewProfileInput(''); setAddingProfile(false);
                  });
                }}
              >✓</button>
              <button
                type="button"
                className="micro-button micro-button--danger"
                title="Cancel creating a new profile."
                onClick={() => { setNewProfileInput(''); setAddingProfile(false); }}
              >✕</button>
            </>
          ) : (
            <>
              <select
                className="macro-select macro-select--profile"
                value={state?.config.activeProfile ?? ''}
                onChange={e => void update(() => api.switchProfile(e.target.value))}
                disabled={busyOp}
                title="Choose the active macro profile to edit and use."
              >
                {state?.config.profiles.map((p: MacroProfile) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="micro-button"
                title="Add a new macro profile."
                onClick={() => setAddingProfile(true)}
              >＋</button>
              <button
                type="button"
                className="micro-button micro-button--danger"
                title="Delete the active macro profile. The Default profile cannot be deleted."
                disabled={state?.config.activeProfile === 'Default'}
                onClick={() => {
                  if (confirm(`Delete profile "${state?.config.activeProfile}"?`))
                    void update(() => api.deleteProfile(state!.config.activeProfile));
                }}
              >🗑</button>
            </>
          )}
        </div>

        {/* Process bindings */}
        <div className="process-bindings">
          <div className="process-bindings-header">
            <span className="process-bindings-label">Auto-switch on focus</span>
            <button
              type="button"
              className="micro-button"
              title="Refresh the list of running apps for profile auto-switch bindings."
              onClick={() => void loadActiveApps()}
              disabled={appsLoading}
            >{appsLoading ? '…' : '↺'}</button>
          </div>
          <div className="process-apps-list">
            {activeApps.map(appName => {
              const bound = profile?.processBindings?.includes(appName) ?? false;
              return (
                <div key={appName} className={`process-app-row${bound ? ' process-app-row--bound' : ''}`}>
                  <span className="process-app-name">{appName}</span>
                  <button
                    type="button"
                    className={`micro-button${bound ? ' micro-button--danger' : ''}`}
                    title={bound ? 'Remove this app from the active profile auto-switch bindings.' : 'Bind this app to the active profile so focusing it switches profiles.'}
                    onClick={() => {
                      if (!profile) return;
                      const bindings = bound
                        ? (profile.processBindings ?? []).filter(b => b !== appName)
                        : [...(profile.processBindings ?? []), appName];
                      void update(() => api.updateProcessBindings(profile.name, bindings));
                    }}
                  >{bound ? '✕' : '＋'}</button>
                </div>
              );
            })}
            {activeApps.length === 0 && !appsLoading && (
              <div className="process-apps-empty">No apps found. Click ↺ to refresh.</div>
            )}
          </div>
        </div>

        {/* Tree actions */}
        <div className="macros-tree-actions">
          <button type="button" className="ghost-button ghost-button--sm" title="Create a new macro in the active profile." onClick={() => {
            const m = blankMacro();
            void update(() => api.upsertMacro(m)).then(() => setSelectedMacroId(m.id));
          }}>＋ Macro</button>
          <button type="button" className="ghost-button ghost-button--sm" title="Create a folder for organizing macros." onClick={() => {
            const f = blankFolder();
            void update(() => api.upsertFolder(f));
          }}>📁 Folder</button>
        </div>

        {/* Error */}
        {error && <div className="error-banner">{error}</div>}

        {/* Macro tree */}
        <div className="macro-tree">
          {/* Root macros */}
          {profile?.macros.map((macro: Macro) => (
            <MacroTreeItem
              key={macro.id}
              macro={macro}
              selected={selectedMacroId === macro.id}
              running={runningId === macro.id}
              onSelect={() => setSelectedMacroId(macro.id)}
              onRun={async () => {
                setRunningId(macro.id);
                await call(() => api.runMacro(macro.id));
                setRunningId(null);
              }}
              onDelete={() => void update(() => api.deleteMacro(macro.id))}
              folders={profile.folders}
              onMove={folderId => void update(() => api.moveMacroToFolder(macro.id, folderId))}
            />
          ))}

          {/* Folders */}
          {profile?.folders.map((folder: MacroFolder) => (
            <div key={folder.id} className="macro-folder">
              <div className="macro-folder-header">
                <button
                  type="button"
                  className="macro-folder-toggle"
                  title={expandedFolders.has(folder.id) ? 'Collapse this macro folder.' : 'Expand this macro folder.'}
                  onClick={() => setExpandedFolders(prev => {
                    const next = new Set(prev);
                    if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id);
                    return next;
                  })}
                >
                  {expandedFolders.has(folder.id) ? '▾' : '▸'} 📁 {folder.name}
                </button>
                <div className="macro-folder-actions">
                  <button type="button" className="micro-button" onClick={() => {
                    const m = blankMacro();
                    void update(() => api.upsertMacro(m)).then(async () => {
                      await api.moveMacroToFolder(m.id, folder.id);
                      void refresh().then(() => setSelectedMacroId(m.id));
                    });
                  }} title="Add macro to folder">＋</button>
                  <button type="button" className="micro-button micro-button--danger" onClick={() => {
                    if (confirm(`Delete folder "${folder.name}"? Macros will be moved to root.`))
                      void update(() => api.deleteFolder(folder.id));
                  }} title="Delete folder">🗑</button>
                </div>
              </div>
              {expandedFolders.has(folder.id) && folder.macros.map((macro: Macro) => (
                <MacroTreeItem
                  key={macro.id}
                  macro={macro}
                  selected={selectedMacroId === macro.id}
                  running={runningId === macro.id}
                  indent
                  onSelect={() => setSelectedMacroId(macro.id)}
                  onRun={async () => {
                    setRunningId(macro.id);
                    await call(() => api.runMacro(macro.id));
                    setRunningId(null);
                  }}
                  onDelete={() => void update(() => api.deleteMacro(macro.id))}
                  folders={profile.folders}
                  onMove={fId => void update(() => api.moveMacroToFolder(macro.id, fId))}
                />
              ))}
            </div>
          ))}

          {(!profile?.macros.length && !profile?.folders.length) && (
            <div className="empty-state">No macros yet. Click ＋ Macro to create one.</div>
          )}
        </div>
      </div>

      {/* ── Right panel: macro editor ── */}
      <div className="macros-editor">
        {selectedMacro ? (
          <MacroEditor
            macro={selectedMacro}
            onChange={saveMacro}
            onDelete={() => {
              setSelectedMacroId(null);
              void update(() => api.deleteMacro(selectedMacro.id));
            }}
            onRun={async () => {
              setRunningId(selectedMacro.id);
              await call(() => api.runMacro(selectedMacro.id));
              setRunningId(null);
            }}
            running={runningId === selectedMacro.id}
          />
        ) : (
          <div className="macros-editor-empty">
            <p>Select a macro to edit, or click <strong>＋ Macro</strong> to create one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MacroTreeItem ─────────────────────────────────────────────────────────

function MacroTreeItem({
  macro, selected, running, indent, onSelect, onRun, onDelete, folders, onMove,
}: {
  macro: Macro;
  selected: boolean;
  running: boolean;
  indent?: boolean;
  onSelect: () => void;
  onRun: () => Promise<void>;
  onDelete: () => void;
  folders: MacroFolder[];
  onMove: (folderId: string | null) => void;
}): ReactElement {
  return (
    <div className={`macro-tree-item${selected ? ' macro-tree-item--selected' : ''}${indent ? ' macro-tree-item--indent' : ''}`}>
      <button type="button" className="macro-tree-label" onClick={onSelect} title="Select this macro for editing.">
        <span className={`macro-enabled-dot ${macro.enabled ? 'macro-enabled-dot--on' : ''}`} />
        <span className="macro-tree-name">{macro.name || '(unnamed)'}</span>
        {macro.hotkey && <code className="macro-tree-hotkey">{macro.hotkey}</code>}
      </button>
      <div className="macro-tree-item-actions">
        <button type="button" className="micro-button" onClick={e => { e.stopPropagation(); void onRun(); }} title="Run this macro now." disabled={running}>
          {running ? '⏳' : '▶'}
        </button>
        <button type="button" className="micro-button micro-button--danger" onClick={e => { e.stopPropagation(); onDelete(); }} title="Delete this macro.">
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── MacroEditor ──────────────────────────────────────────────────────────

function MacroEditor({
  macro, onChange, onDelete, onRun, running,
}: {
  macro: Macro;
  onChange: (m: Macro) => void;
  onDelete: () => void;
  onRun: () => Promise<void>;
  running: boolean;
}): ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const addAction = (type: MacroAction['type']) => {
    let action: MacroAction;
    switch (type) {
      case 'delay': action = { id: newId(), type: 'delay', enabled: true, milliseconds: 500 }; break;
      case 'keyboard': action = { id: newId(), type: 'keyboard', enabled: true, key: 'Enter', pressType: 'press' }; break;
      case 'mouse': action = { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'click' }; break;
      case 'launch': action = { id: newId(), type: 'launch', enabled: true, path: '', arguments: '' }; break;
      case 'command': action = { id: newId(), type: 'command', enabled: true, command: '', workingDirectory: '' }; break;
      case 'text': action = { id: newId(), type: 'text', enabled: true, text: '' }; break;
    }
    onChange({ ...macro, actions: [...macro.actions, action] });
  };

  const updateAction = (idx: number, updated: MacroAction) => {
    const actions = macro.actions.map((a: MacroAction, i: number) => i === idx ? updated : a);
    onChange({ ...macro, actions });
  };

  const deleteAction = (idx: number) => {
    onChange({ ...macro, actions: macro.actions.filter((_: MacroAction, i: number) => i !== idx) });
  };

  const moveAction = (from: number, to: number) => {
    if (to < 0 || to >= macro.actions.length || from === to) return;
    const actions = [...macro.actions];
    const [item] = actions.splice(from, 1);
    actions.splice(to, 0, item);
    onChange({ ...macro, actions });
  };

  return (
    <div className="macro-editor-panel">
      {/* Header */}
      <div className="macro-editor-header">
        <input
          className="macro-name-input"
          value={macro.name}
          placeholder="Macro name"
          onChange={e => onChange({ ...macro, name: e.target.value })}
          title="Name shown in the macro list."
        />
        <div className="macro-editor-header-actions">
          <label className="macro-toggle-label">
            <input
              type="checkbox"
              checked={macro.enabled}
              onChange={e => onChange({ ...macro, enabled: e.target.checked })}
              title="When disabled, the macro will not run from its hotkey."
            />
            Enabled
          </label>
          <button
            type="button"
            className="toggle-button"
            onClick={() => void onRun()}
            disabled={running}
            title="Run this macro immediately."
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
          <button type="button" className="toggle-button toggle-button--restore" onClick={onDelete} title="Delete this macro.">
            Delete
          </button>
        </div>
      </div>

      {/* Hotkey */}
      <div className="macro-field-row">
        <label className="macro-label">Global Hotkey</label>
        <HotkeyInput
          value={macro.hotkey}
          onChange={hk => onChange({ ...macro, hotkey: hk })}
          placeholder="Click and press key combination…"
        />
        {macro.hotkey && (
          <button type="button" className="micro-button" onClick={() => onChange({ ...macro, hotkey: '' })} title="Clear this macro hotkey.">✕</button>
        )}
      </div>

      {/* Actions list */}
      <div className="macro-actions-header">
        <span>Actions ({macro.actions.length})</span>
        <div className="macro-add-actions">
          {(['delay', 'keyboard', 'mouse', 'text', 'launch', 'command'] as MacroAction['type'][]).map(t => (
            <button key={t} type="button" className="ghost-button ghost-button--xs" onClick={() => addAction(t)} title={macroActionDescriptions[t]}>
              +{t}
            </button>
          ))}
        </div>
      </div>

      <div className="macro-actions-list">
        {macro.actions.length === 0 && (
          <div className="empty-state">No actions yet. Add one above.</div>
        )}
        {macro.actions.map((action, idx) => (
          <div
            key={action.id}
            className={`action-wrapper${dropIndex === idx ? ' action-wrapper--drop-before' : ''}${dropIndex === idx + 1 ? ' action-wrapper--drop-after' : ''}`}
            draggable
            onDragStart={() => {
              setDragIndex(idx);
              setDropIndex(idx);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const before = event.clientY < rect.top + rect.height / 2;
              setDropIndex(before ? idx : idx + 1);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragIndex !== null && dropIndex !== null) {
                let target = dropIndex;
                if (target > dragIndex) {
                  target -= 1;
                }
                moveAction(dragIndex, target);
              }
              setDragIndex(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDropIndex(null);
            }}
          >
            <div className="action-reorder" title="Drag to reorder">
              <span className="action-drag-handle">⋮⋮</span>
              <span className="action-index">{idx + 1}</span>
            </div>
            <ActionEditor
              action={action}
              onChange={updated => updateAction(idx, updated)}
              onDelete={() => deleteAction(idx)}
            />
          </div>
        ))}
        {macro.actions.length > 0 ? <div className={`action-drop-end${dropIndex === macro.actions.length ? ' action-drop-end--active' : ''}`} /> : null}
      </div>
    </div>
  );
}
