import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeMacroPlayback } from '../../shared/macro';
import type {
  CommandAction,
  DelayAction,
  IfAction,
  KeyboardAction,
  LaunchAction,
  Macro,
  MacroAction,
  MacroCondition,
  MacroConditionOperator,
  MacroConditionSource,
  MacroFolder,
  MacroPlaybackMode,
  MacroPlaybackOptions,
  MacroProfile,
  MacroState,
  MouseAction,
  RepeatAction,
  TextAction,
} from '../../shared/macro';

// ─── Helpers ──────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function blankMacro(name = 'New Macro'): Macro {
  return { id: newId(), name, hotkey: '', actions: [], enabled: true, playback: normalizeMacroPlayback(undefined) };
}

function blankFolder(name = 'New Folder'): MacroFolder {
  return { id: newId(), name, macros: [], isExpanded: true };
}

function blankCondition(): MacroCondition {
  return { source: 'active-process', operator: 'contains', value: '', caseSensitive: false };
}

function blankAction(type: MacroAction['type']): MacroAction {
  switch (type) {
    case 'delay': return { id: newId(), type: 'delay', enabled: true, milliseconds: 500 };
    case 'keyboard': return { id: newId(), type: 'keyboard', enabled: true, key: 'Enter', pressType: 'press' };
    case 'mouse': return { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'click' };
    case 'launch': return { id: newId(), type: 'launch', enabled: true, path: '', arguments: '' };
    case 'command': return { id: newId(), type: 'command', enabled: true, command: '', workingDirectory: '' };
    case 'text': return { id: newId(), type: 'text', enabled: true, text: '' };
    case 'repeat': return { id: newId(), type: 'repeat', enabled: true, times: 10, actions: [] };
    case 'if': return { id: newId(), type: 'if', enabled: true, condition: blankCondition(), thenActions: [], elseActions: [] };
  }
}

function keyboardHoldReleaseActions(key: string): MacroAction[] {
  return [
    { id: newId(), type: 'delay', enabled: true, milliseconds: 100 },
    { id: newId(), type: 'keyboard', enabled: true, key, pressType: 'up' },
  ];
}

function updateActionAt(actions: MacroAction[], index: number, updated: MacroAction, insertAfter: MacroAction[] = []): MacroAction[] {
  const previous = actions[index];
  const next = actions.flatMap((action, actionIndex) => (
    actionIndex === index ? [updated, ...insertAfter] : [action]
  ));

  if (
    previous?.type === 'keyboard'
    && updated.type === 'keyboard'
    && previous.pressType === 'down'
    && updated.pressType === 'down'
    && previous.key !== updated.key
    && insertAfter.length === 0
  ) {
    const delayAction = next[index + 1];
    const keyUpAction = next[index + 2];
    if (delayAction?.type === 'delay' && keyUpAction?.type === 'keyboard' && keyUpAction.pressType === 'up' && keyUpAction.key === previous.key) {
      next[index + 2] = { ...keyUpAction, key: updated.key };
    }
  }

  return next;
}

function captureKeyName(event: React.KeyboardEvent<HTMLInputElement>): string {
  const numpadKey = captureNumpadKeyName(event.code);
  if (numpadKey) return numpadKey;

  if (event.key === 'Control') return 'Ctrl';
  if (event.key === 'Alt') return 'Alt';
  if (event.key === 'Shift') return 'Shift';
  if (event.key === 'Meta' || event.key === 'OS') return 'Win';
  if (event.key === 'Enter') return 'Enter';
  if (event.key === ' ') return 'Space';
  if (event.key.length === 1) return event.key.toUpperCase();

  return event.key;
}

function isCapturedModifierKey(key: string): boolean {
  return key === 'Ctrl' || key === 'Alt' || key === 'Shift' || key === 'Win';
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
    case 'repeat': return `Repeat ${a.times}x`;
    case 'if': return `If ${conditionSourceLabels[a.condition.source]}`;
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
  repeat: 'Run a nested action group a fixed number of times.',
  if: 'Run one branch or another when a condition matches.',
};

const actionTypes: MacroAction['type'][] = ['delay', 'keyboard', 'mouse', 'text', 'repeat', 'if', 'launch', 'command'];

const conditionSourceLabels: Record<MacroConditionSource, string> = {
  'active-process': 'Active process',
  'active-window-title': 'Active window title',
  'clipboard-text': 'Clipboard text',
  'file-exists': 'File path',
  'key-state': 'Key state',
};

const conditionOperatorLabels: Record<MacroConditionOperator, string> = {
  contains: 'Contains',
  equals: 'Equals',
  matches: 'Regex matches',
  'not-contains': 'Does not contain',
  'not-equals': 'Does not equal',
  'not-matches': 'Regex does not match',
  exists: 'Exists',
  'not-exists': 'Does not exist',
  'is-pressed': 'Is pressed',
  'is-not-pressed': 'Is not pressed',
};

const textConditionOperators: MacroConditionOperator[] = ['contains', 'equals', 'matches', 'not-contains', 'not-equals', 'not-matches'];
const fileConditionOperators: MacroConditionOperator[] = ['exists', 'not-exists'];
const keyConditionOperators: MacroConditionOperator[] = ['is-pressed', 'is-not-pressed'];

const macroPlaybackModes: MacroPlaybackMode[] = ['once', 'multiple', 'toggle', 'while-pressed', 'queue'];

const macroPlaybackLabels: Record<MacroPlaybackMode, string> = {
  once: 'Play once',
  multiple: 'Play multiple times',
  toggle: 'Toggle continuous playback on/off',
  'while-pressed': 'Play while assigned key is pressed',
  queue: 'Queue',
};

const macroPlaybackDescriptions: Record<MacroPlaybackMode, string> = {
  once: 'Runs the macro once when the hotkey is pressed.',
  multiple: 'Runs the macro a fixed number of times when the hotkey is pressed.',
  toggle: 'Starts or stops a continuous macro loop each time the hotkey is pressed.',
  'while-pressed': 'Loops the macro while the assigned hotkey is held down.',
  queue: 'Adds another macro run to the queue each time the hotkey is pressed.',
};

interface MacroPreset {
  id: string;
  label: string;
  description: string;
  createActions: (options: MacroPresetOptions) => MacroAction[];
}

type AutoClickerTimingMode = 'delay' | 'cps';

interface AutoClickerPresetOptions {
  repeatCount: number;
  timingMode: AutoClickerTimingMode;
  delayMs: number;
  clicksPerSecond: number;
}

interface MacroPresetOptions {
  autoClicker: AutoClickerPresetOptions;
}

const AUTO_CLICKER_CLICK_MS = 0;
const DEFAULT_AUTO_CLICKER_OPTIONS: AutoClickerPresetOptions = {
  repeatCount: 50,
  timingMode: 'delay',
  delayMs: 0,
  clicksPerSecond: 20,
};

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  const integer = Math.trunc(Number(value));
  if (!Number.isFinite(integer)) return fallback;
  return Math.max(min, Math.min(max, integer));
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

type ActionPairRole = 'start' | 'middle' | 'end';

interface ActionPairDecoration {
  pairIndex: number;
  role: ActionPairRole;
  label: string;
}

const actionPairColors = ['#8dd2ff', '#f8c36a', '#7bd88f', '#ff8aa1', '#c59cff'];

function normalizedActionKey(key: string): string {
  return key.trim().toLowerCase();
}

function actionPairRole(action: MacroAction): 'down' | 'up' | null {
  if (action.type === 'keyboard') {
    if (action.pressType === 'down') return 'down';
    if (action.pressType === 'up') return 'up';
  }

  if (action.type === 'mouse') {
    if (action.actionType === 'down') return 'down';
    if (action.actionType === 'up') return 'up';
  }

  return null;
}

function actionPairKey(action: MacroAction): string | null {
  if (action.type === 'keyboard' && actionPairRole(action)) {
    return `keyboard:${normalizedActionKey(action.key)}`;
  }

  if (action.type === 'mouse' && actionPairRole(action)) {
    return `mouse:${action.button}`;
  }

  return null;
}

function actionPairLabel(action: MacroAction): string {
  if (action.type === 'keyboard') return `Linked ${action.key}`;
  if (action.type === 'mouse') return `Linked ${action.button} button`;
  return 'Linked down/up pair';
}

function buildActionPairDecorations(actions: MacroAction[]): Map<string, ActionPairDecoration> {
  const decorations = new Map<string, ActionPairDecoration>();
  const stacks = new Map<string, number[]>();
  let pairIndex = 0;

  actions.forEach((action, index) => {
    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) return;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(index);
      stacks.set(key, stack);
      return;
    }

    const stack = stacks.get(key);
    const startIndex = stack?.pop();
    if (startIndex === undefined) return;

    const currentPairIndex = pairIndex++;
    const label = actionPairLabel(actions[startIndex]);
    for (let actionIndex = startIndex; actionIndex <= index; actionIndex++) {
      const linkedAction = actions[actionIndex];
      if (decorations.has(linkedAction.id)) continue;
      decorations.set(linkedAction.id, {
        pairIndex: currentPairIndex,
        role: actionIndex === startIndex ? 'start' : actionIndex === index ? 'end' : 'middle',
        label,
      });
    }
  });

  return decorations;
}

function actionPairStyle(decoration: ActionPairDecoration | undefined): CSSProperties | undefined {
  if (!decoration) return undefined;
  const offsetSteps = [0, 5, -5, 10, -10];
  return {
    '--action-link-color': actionPairColors[decoration.pairIndex % actionPairColors.length],
    '--action-link-offset': `${offsetSteps[decoration.pairIndex % offsetSteps.length]}px`,
  } as CSSProperties;
}

function countDelayActions(actions: MacroAction[]): number {
  return actions.reduce((count, action) => {
    if (action.type === 'delay') return count + 1;
    if (action.type === 'repeat') return count + countDelayActions(action.actions);
    if (action.type === 'if') return count + countDelayActions(action.thenActions) + countDelayActions(action.elseActions);
    return count;
  }, 0);
}

function countDelayExecutions(actions: MacroAction[], multiplier = 1): number {
  return actions.reduce((count, action) => {
    if (action.type === 'delay') return count + multiplier;
    if (action.type === 'repeat') return count + countDelayExecutions(action.actions, multiplier * clampInteger(action.times, 0, 10_000, 0));
    if (action.type === 'if') return count + countDelayExecutions(action.thenActions, multiplier) + countDelayExecutions(action.elseActions, multiplier);
    return count;
  }, 0);
}

function fitDelayActionsToRunTime(actions: MacroAction[], totalMs: number): MacroAction[] {
  const delayExecutions = countDelayExecutions(actions);
  if (delayExecutions === 0) return actions;

  const total = clampInteger(totalMs, 0, 24 * 60 * 60 * 1000, 0);
  const baseDelay = Math.floor(total / delayExecutions);
  let remainder = total % delayExecutions;

  const apply = (items: MacroAction[], multiplier = 1): MacroAction[] => items.map(action => {
    if (action.type === 'delay') {
      const milliseconds = baseDelay + (remainder >= multiplier ? 1 : 0);
      if (remainder >= multiplier) remainder -= multiplier;
      return { ...action, milliseconds };
    }

    if (action.type === 'repeat') return { ...action, actions: apply(action.actions, multiplier * clampInteger(action.times, 0, 10_000, 0)) };
    if (action.type === 'if') return { ...action, thenActions: apply(action.thenActions, multiplier), elseActions: apply(action.elseActions, multiplier) };
    return action;
  });

  return apply(actions);
}

function hasActionPair(actions: MacroAction[]): boolean {
  const stacks = new Map<string, number[]>();

  for (const action of actions) {
    if (action.type === 'repeat' && hasActionPair(action.actions)) return true;
    if (action.type === 'if' && (hasActionPair(action.thenActions) || hasActionPair(action.elseActions))) return true;

    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) continue;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(1);
      stacks.set(key, stack);
      continue;
    }

    const stack = stacks.get(key);
    if (stack?.length) return true;
  }

  return false;
}

function toPressAction(action: MacroAction): MacroAction {
  if (action.type === 'keyboard') return { ...action, pressType: 'press' };
  if (action.type === 'mouse') return { ...action, actionType: 'click' };
  return action;
}

function convertFlatActionPairsToPress(actions: MacroAction[]): MacroAction[] {
  const stacks = new Map<string, number[]>();
  const replacements = new Map<string, MacroAction>();
  const removeIds = new Set<string>();

  actions.forEach((action, index) => {
    const key = actionPairKey(action);
    const role = actionPairRole(action);
    if (!key || !role) return;

    if (role === 'down') {
      const stack = stacks.get(key) ?? [];
      stack.push(index);
      stacks.set(key, stack);
      return;
    }

    const stack = stacks.get(key);
    const startIndex = stack?.pop();
    if (startIndex === undefined) return;

    const startAction = actions[startIndex];
    replacements.set(startAction.id, toPressAction(startAction));
    removeIds.add(action.id);

    const between = actions.slice(startIndex + 1, index);
    if (between.length > 0 && between.every(item => item.type === 'delay')) {
      between.forEach(item => removeIds.add(item.id));
    }
  });

  return actions
    .filter(action => !removeIds.has(action.id))
    .map(action => replacements.get(action.id) ?? action);
}

function convertActionPairsToPress(actions: MacroAction[]): MacroAction[] {
  const convertedNested = actions.map(action => {
    if (action.type === 'repeat') return { ...action, actions: convertActionPairsToPress(action.actions) };
    if (action.type === 'if') {
      return {
        ...action,
        thenActions: convertActionPairsToPress(action.thenActions),
        elseActions: convertActionPairsToPress(action.elseActions),
      };
    }
    return action;
  });

  return convertFlatActionPairsToPress(convertedNested);
}

function autoClickerDelayMs(options: AutoClickerPresetOptions): number {
  if (options.timingMode === 'delay') {
    return clampInteger(options.delayMs, 0, 60_000, DEFAULT_AUTO_CLICKER_OPTIONS.delayMs);
  }

  const clicksPerSecond = clampFloat(options.clicksPerSecond, 0.1, 10_000, DEFAULT_AUTO_CLICKER_OPTIONS.clicksPerSecond);
  const targetPeriodMs = 1000 / clicksPerSecond;
  return Math.max(0, Math.floor(targetPeriodMs - AUTO_CLICKER_CLICK_MS));
}

const macroPresets: MacroPreset[] = [
  {
    id: 'auto-clicker',
    label: 'Auto Clicker',
    description: 'Left-click repeatedly with a configurable pause between clicks.',
    createActions: ({ autoClicker }) => [{
      id: newId(),
      type: 'repeat',
      enabled: true,
      times: clampInteger(autoClicker.repeatCount, 1, 10_000, DEFAULT_AUTO_CLICKER_OPTIONS.repeatCount),
      actions: [
        { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'click' },
        { id: newId(), type: 'delay', enabled: true, milliseconds: autoClickerDelayMs(autoClicker) },
      ],
    }],
  },
  {
    id: 'key-spammer',
    label: 'Key Spammer',
    description: 'Press Space repeatedly with a short pause between presses.',
    createActions: () => [{
      id: newId(),
      type: 'repeat',
      enabled: true,
      times: 25,
      actions: [
        { id: newId(), type: 'keyboard', enabled: true, key: 'Space', pressType: 'press' },
        { id: newId(), type: 'delay', enabled: true, milliseconds: 120 },
      ],
    }],
  },
  {
    id: 'hold-left-click',
    label: 'Hold Left Click',
    description: 'Hold left mouse down for one second, then release it.',
    createActions: () => [
      { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'down' },
      { id: newId(), type: 'delay', enabled: true, milliseconds: 1000 },
      { id: newId(), type: 'mouse', enabled: true, button: 'left', actionType: 'up' },
    ],
  },
  {
    id: 'window-title-if',
    label: 'Window Title If',
    description: 'Run different actions depending on the focused window title.',
    createActions: () => [{
      id: newId(),
      type: 'if',
      enabled: true,
      condition: { source: 'active-window-title', operator: 'contains', value: '', caseSensitive: false },
      thenActions: [{ id: newId(), type: 'text', enabled: true, text: 'Matched window' }],
      elseActions: [{ id: newId(), type: 'text', enabled: true, text: 'Other window' }],
    }],
  },
];

// ─── Hotkey capture input ─────────────────────────────────────────────────

function HotkeyInput({
  value,
  onChange,
  placeholder = 'Click and press keys…',
  title = 'Click here, then press the key combination that should trigger this macro globally.',
  allowModifierKeys = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
  allowModifierKeys?: boolean;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  const [pendingModifierHotkey, setPendingModifierHotkey] = useState<string | null>(null);

  const finishCapture = (nextValue: string) => {
    onChange(nextValue);
    setPendingModifierHotkey(null);
    setCapturing(false);
  };

  const modifierPartsForEvent = (event: React.KeyboardEvent<HTMLInputElement>, capturedKey: string): string[] => {
    const parts: string[] = [];
    if (event.ctrlKey || capturedKey === 'Ctrl') parts.push('Ctrl');
    if (event.altKey || capturedKey === 'Alt') parts.push('Alt');
    if (event.shiftKey || capturedKey === 'Shift') parts.push('Shift');
    if (event.metaKey || capturedKey === 'Win') parts.push('Win');
    return parts;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const capturedKey = captureKeyName(e);
    if (isCapturedModifierKey(capturedKey) && !allowModifierKeys) return;

    if (isCapturedModifierKey(capturedKey)) {
      setPendingModifierHotkey(modifierPartsForEvent(e, capturedKey).join('+'));
      return;
    }

    const parts = modifierPartsForEvent(e, capturedKey);
    parts.push(capturedKey);
    finishCapture(parts.join('+'));
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (pendingModifierHotkey && isCapturedModifierKey(captureKeyName(e))) {
      finishCapture(pendingModifierHotkey);
    }
  };

  return (
    <input
      className={`macro-input${capturing ? ' macro-input--capturing' : ''}`}
      value={capturing ? pendingModifierHotkey ?? '' : value}
      placeholder={capturing ? 'Press keys…' : placeholder}
      readOnly={!capturing}
      onFocus={() => {
        setPendingModifierHotkey(null);
        setCapturing(true);
      }}
      onBlur={() => {
        setPendingModifierHotkey(null);
        setCapturing(false);
      }}
      onKeyDown={capturing ? handleKeyDown : undefined}
      onKeyUp={capturing ? handleKeyUp : undefined}
      onChange={() => {}}
      title={title}
    />
  );
}

function conditionOperatorsForSource(source: MacroConditionSource): MacroConditionOperator[] {
  if (source === 'file-exists') return fileConditionOperators;
  if (source === 'key-state') return keyConditionOperators;
  return textConditionOperators;
}

function normalizeConditionForSource(condition: MacroCondition, source: MacroConditionSource): MacroCondition {
  const operators = conditionOperatorsForSource(source);
  return {
    ...condition,
    source,
    operator: operators.includes(condition.operator) ? condition.operator : operators[0],
  };
}

// ─── Action editor ────────────────────────────────────────────────────────

function ActionEditor({
  action,
  onChange,
  onDelete,
  pairDecoration,
}: {
  action: MacroAction;
  onChange: (a: MacroAction, insertAfter?: MacroAction[]) => void;
  onDelete: () => void;
  pairDecoration?: ActionPairDecoration;
}): ReactElement {
  const patch = (updates: Partial<MacroAction>, insertAfter?: MacroAction[]) =>
    onChange({ ...action, ...updates } as MacroAction, insertAfter);

  const patchCondition = (updates: Partial<MacroCondition>) => {
    if (action.type !== 'if') return;
    const current = (action as IfAction).condition;
    patch({ condition: { ...current, ...updates } } as Partial<MacroAction>);
  };

  const changeKeyboardPressType = (pressType: KeyboardAction['pressType']) => {
    if (action.type !== 'keyboard') return;
    const insertAfter = pressType === 'down' && action.pressType !== 'down'
      ? keyboardHoldReleaseActions(action.key)
      : undefined;
    patch({ pressType } as Partial<MacroAction>, insertAfter);
  };

  const anchorDecoration = pairDecoration?.role === 'middle' ? undefined : pairDecoration;
  const pairClass = anchorDecoration ? ` action-row--linked action-row--linked-${anchorDecoration.role}` : '';

  return (
    <div className={`action-row${action.enabled ? '' : ' action-row--disabled'}${pairClass}`} style={actionPairStyle(anchorDecoration)} title={anchorDecoration?.label}>
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
          <HotkeyInput
            value={(action as KeyboardAction).key}
            placeholder="Click and press key…"
            onChange={key => patch({ key } as Partial<MacroAction>)}
            title="Click here, then press the key or key combination this action should send."
            allowModifierKeys
          />
          <label className="macro-label">Type</label>
          <select
            className="macro-select"
            value={(action as KeyboardAction).pressType}
            onChange={e => changeKeyboardPressType(e.target.value as KeyboardAction['pressType'])}
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

      {action.type === 'repeat' && (
        <div className="action-nested-editor">
          <div className="action-fields">
            <label className="macro-label">Times</label>
            <input
              type="number"
              className="macro-input macro-input--half"
              value={(action as RepeatAction).times}
              min={0}
              max={10000}
              onChange={e => patch({ times: Number(e.target.value) } as Partial<MacroAction>)}
              title="How many times to run the nested actions."
            />
          </div>
          <NestedActionsEditor
            label="Repeated actions"
            emptyText="No repeated actions yet."
            actions={(action as RepeatAction).actions}
            onChange={actions => patch({ actions } as Partial<MacroAction>)}
          />
        </div>
      )}

      {action.type === 'if' && (
        <div className="action-nested-editor">
          <div className="macro-condition-grid">
            <label className="macro-label">If</label>
            <select
              className="macro-select"
              value={(action as IfAction).condition.source}
              onChange={e => {
                const source = e.target.value as MacroConditionSource;
                patch({ condition: normalizeConditionForSource((action as IfAction).condition, source) } as Partial<MacroAction>);
              }}
              title="Choose what this condition should inspect."
            >
              {(Object.keys(conditionSourceLabels) as MacroConditionSource[]).map(source => (
                <option key={source} value={source}>{conditionSourceLabels[source]}</option>
              ))}
            </select>

            <label className="macro-label">Operator</label>
            <select
              className="macro-select"
              value={(action as IfAction).condition.operator}
              onChange={e => patchCondition({ operator: e.target.value as MacroConditionOperator })}
              title="Choose how the condition should compare the inspected value."
            >
              {conditionOperatorsForSource((action as IfAction).condition.source).map(operator => (
                <option key={operator} value={operator}>{conditionOperatorLabels[operator]}</option>
              ))}
            </select>

            <label className="macro-label">Value</label>
            {(action as IfAction).condition.source === 'key-state' ? (
              <HotkeyInput
                value={(action as IfAction).condition.value}
                placeholder="Click and press key…"
                onChange={value => patchCondition({ value })}
                title="Click here, then press the key or key combination this IF condition should check."
                allowModifierKeys
              />
            ) : (
              <input
                className="macro-input"
                value={(action as IfAction).condition.value}
                placeholder={(action as IfAction).condition.source === 'file-exists' ? 'C:\\path\\to\\file.txt' : 'Text or regex'}
                onChange={e => patchCondition({ value: e.target.value })}
                title={(action as IfAction).condition.source === 'file-exists' ? 'Path to check for existence.' : 'Text or regular expression to compare against.'}
              />
            )}

            {(action as IfAction).condition.source !== 'file-exists' && (action as IfAction).condition.source !== 'key-state' ? (
              <label className="macro-check-label" title="Make this text comparison case-sensitive.">
                <input
                  type="checkbox"
                  checked={(action as IfAction).condition.caseSensitive}
                  onChange={e => patchCondition({ caseSensitive: e.target.checked })}
                />
                <span>Case</span>
              </label>
            ) : null}
          </div>

          <NestedActionsEditor
            label="Then"
            emptyText="No Then actions yet."
            actions={(action as IfAction).thenActions}
            onChange={thenActions => patch({ thenActions } as Partial<MacroAction>)}
          />
          <NestedActionsEditor
            label="Else"
            emptyText="No Else actions yet."
            actions={(action as IfAction).elseActions}
            onChange={elseActions => patch({ elseActions } as Partial<MacroAction>)}
          />
        </div>
      )}
    </div>
  );
}

function NestedActionsEditor({
  label,
  emptyText,
  actions,
  onChange,
}: {
  label: string;
  emptyText: string;
  actions: MacroAction[];
  onChange: (actions: MacroAction[]) => void;
}): ReactElement {
  const pairDecorations = buildActionPairDecorations(actions);
  const [hoveredPairIndex, setHoveredPairIndex] = useState<number | null>(null);

  const updateAction = (index: number, updated: MacroAction, insertAfter?: MacroAction[]) => {
    onChange(updateActionAt(actions, index, updated, insertAfter));
  };

  const deleteAction = (index: number) => {
    onChange(actions.filter((_, actionIndex) => actionIndex !== index));
  };

  return (
    <div className="nested-actions">
      <div className="nested-actions-header">
        <span>{label}</span>
        <div className="macro-add-actions">
          {actionTypes.map(type => (
            <button key={type} type="button" className="ghost-button ghost-button--xs" onClick={() => onChange([...actions, blankAction(type)])} title={macroActionDescriptions[type]}>
              +{type}
            </button>
          ))}
        </div>
      </div>
      <div className="nested-actions-list">
        {actions.length === 0 ? <div className="empty-state empty-state--compact">{emptyText}</div> : null}
        {actions.map((nestedAction, index) => {
          const decoration = pairDecorations.get(nestedAction.id);
          return (
          <div
            key={nestedAction.id}
            className={`nested-action-row${decoration ? ` nested-action-row--linked nested-action-row--linked-${decoration.role}${hoveredPairIndex === decoration.pairIndex ? ' nested-action-row--linked-hover' : ''}` : ''}`}
            style={actionPairStyle(decoration)}
            onMouseEnter={() => setHoveredPairIndex(decoration?.pairIndex ?? null)}
            onMouseLeave={() => setHoveredPairIndex(null)}
          >
            <span className="nested-action-index">{index + 1}</span>
            <ActionEditor
              action={nestedAction}
              onChange={(updated, insertAfter) => updateAction(index, updated, insertAfter)}
              onDelete={() => deleteAction(index)}
              pairDecoration={actionPairRole(nestedAction) ? decoration : undefined}
            />
          </div>
          );
        })}
      </div>
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
    const normalizedMacro: Macro = { ...macro, playback: normalizeMacroPlayback(macro.playback) };
    setState(prev => {
      if (!prev) return prev;
      const p = prev.activeProfile;
      const patchProfile = (prof: MacroProfile): MacroProfile => ({
        ...prof,
        macros: prof.macros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
        folders: prof.folders.map((f: MacroFolder) => ({
          ...f,
          macros: f.macros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
        })),
      });
      return {
        ...prev,
        activeProfile: patchProfile(p),
        allMacros: prev.allMacros.map((m: Macro) => m.id === normalizedMacro.id ? normalizedMacro : m),
      };
    });
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      void api.upsertMacro(normalizedMacro).then(s => setState(s)).catch(() => {});
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
  const [selectedPresetId, setSelectedPresetId] = useState(macroPresets[0]?.id ?? '');
  const [autoClickerOptions, setAutoClickerOptions] = useState<AutoClickerPresetOptions>(DEFAULT_AUTO_CLICKER_OPTIONS);
  const [targetRunTimeMs, setTargetRunTimeMs] = useState(100);
  const [hoveredPairIndex, setHoveredPairIndex] = useState<number | null>(null);
  const playback = normalizeMacroPlayback(macro.playback);
  const selectedPreset = macroPresets.find(item => item.id === selectedPresetId) ?? macroPresets[0];
  const calculatedAutoClickerDelay = autoClickerDelayMs(autoClickerOptions);
  const delayActionCount = countDelayActions(macro.actions);
  const hasLinkedActionPairs = hasActionPair(macro.actions);
  const pairDecorations = buildActionPairDecorations(macro.actions);

  const updateAutoClickerOptions = (updates: Partial<AutoClickerPresetOptions>) => {
    setAutoClickerOptions(prev => ({ ...prev, ...updates }));
  };

  const updatePlayback = (updates: Partial<MacroPlaybackOptions>) => {
    onChange({ ...macro, playback: normalizeMacroPlayback({ ...playback, ...updates }) });
  };

  const addAction = (type: MacroAction['type']) => {
    onChange({ ...macro, actions: [...macro.actions, blankAction(type)] });
  };

  const insertPreset = () => {
    if (!selectedPreset) return;
    onChange({ ...macro, actions: [...macro.actions, ...selectedPreset.createActions({ autoClicker: autoClickerOptions })] });
  };

  const updateAction = (idx: number, updated: MacroAction, insertAfter?: MacroAction[]) => {
    onChange({ ...macro, actions: updateActionAt(macro.actions, idx, updated, insertAfter) });
  };

  const deleteAction = (idx: number) => {
    onChange({ ...macro, actions: macro.actions.filter((_: MacroAction, i: number) => i !== idx) });
  };

  const fitRunTime = () => {
    onChange({ ...macro, actions: fitDelayActionsToRunTime(macro.actions, targetRunTimeMs) });
  };

  const convertPairsToPress = () => {
    onChange({ ...macro, actions: convertActionPairsToPress(macro.actions) });
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
          allowModifierKeys
        />
        {macro.hotkey && (
          <button type="button" className="micro-button" onClick={() => onChange({ ...macro, hotkey: '' })} title="Clear this macro hotkey.">✕</button>
        )}
      </div>

      <div className="macro-playback-row">
        <label className="macro-label">Playback Option</label>
        <select
          className="macro-select macro-playback-select"
          value={playback.mode}
          onChange={e => updatePlayback({ mode: e.target.value as MacroPlaybackMode })}
          title={macroPlaybackDescriptions[playback.mode]}
        >
          {macroPlaybackModes.map(mode => (
            <option key={mode} value={mode}>{macroPlaybackLabels[mode]}</option>
          ))}
        </select>

        {playback.mode === 'multiple' ? (
          <>
            <label className="macro-label">Runs</label>
            <input
              type="number"
              className="macro-input macro-input--short"
              value={playback.repeatCount}
              min={1}
              max={10000}
              onChange={e => updatePlayback({ repeatCount: Number(e.target.value) })}
              title="How many whole macro runs this hotkey press should start."
            />
          </>
        ) : null}

      </div>

      {/* Actions list */}
      <div className="macro-actions-header">
        <span>Actions ({macro.actions.length})</span>
        <div className="macro-add-actions">
          {actionTypes.map(t => (
            <button key={t} type="button" className="ghost-button ghost-button--xs" onClick={() => addAction(t)} title={macroActionDescriptions[t]}>
              +{t}
            </button>
          ))}
        </div>
      </div>

      <div className="macro-tools-row">
        <label className="macro-label">Run time (ms)</label>
        <input
          type="number"
          className="macro-input macro-input--short"
          value={targetRunTimeMs}
          min={0}
          max={86400000}
          onChange={e => setTargetRunTimeMs(Number(e.target.value))}
          title="Target total delay time for this macro. Existing Delay nodes are evenly redistributed to match it."
        />
        <button
          type="button"
          className="ghost-button ghost-button--sm"
          onClick={fitRunTime}
          disabled={delayActionCount === 0}
          title="Evenly split the target time across every Delay action in this macro, including nested actions."
        >
          Fit Delays
        </button>
        <span className="macro-tool-hint">{delayActionCount} delay node{delayActionCount === 1 ? '' : 's'}</span>
        <button
          type="button"
          className="ghost-button ghost-button--sm"
          onClick={convertPairsToPress}
          disabled={!hasLinkedActionPairs}
          title="Convert linked Key Down/Key Up and Mouse Down/Mouse Up pairs into single Press or Click actions."
        >
          Convert Pairs to Press
        </button>
      </div>

      <div className="macro-preset-panel">
        <div className="macro-preset-row">
          <label className="macro-label">Preset</label>
          <select
            className="macro-select macro-preset-select"
            value={selectedPresetId}
            onChange={e => setSelectedPresetId(e.target.value)}
            title="Choose a common macro preset to insert into this macro."
          >
            {macroPresets.map(preset => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="ghost-button ghost-button--sm"
            onClick={insertPreset}
            title={selectedPreset?.description ?? 'Insert the selected preset.'}
          >
            Insert Preset
          </button>
        </div>

        {selectedPresetId === 'auto-clicker' ? (
          <div className="macro-preset-options">
            <label className="macro-label">Clicks</label>
            <input
              type="number"
              className="macro-input macro-input--short"
              value={autoClickerOptions.repeatCount}
              min={1}
              max={10000}
              onChange={e => updateAutoClickerOptions({ repeatCount: Number(e.target.value) })}
              title="How many clicks the inserted repeat block should contain."
            />
            <div className="macro-preset-mode" role="group" aria-label="Auto Clicker timing mode">
              <button
                type="button"
                className={`macro-preset-mode-button${autoClickerOptions.timingMode === 'delay' ? ' macro-preset-mode-button--active' : ''}`}
                onClick={() => updateAutoClickerOptions({ timingMode: 'delay' })}
                title="Use an explicit delay after each click."
              >
                Delay
              </button>
              <button
                type="button"
                className={`macro-preset-mode-button${autoClickerOptions.timingMode === 'cps' ? ' macro-preset-mode-button--active' : ''}`}
                onClick={() => updateAutoClickerOptions({ timingMode: 'cps' })}
                title="Calculate the delay from a target clicks-per-second rate."
              >
                Target CPS
              </button>
            </div>
            {autoClickerOptions.timingMode === 'delay' ? (
              <>
                <label className="macro-label">Delay (ms)</label>
                <input
                  type="number"
                  className="macro-input macro-input--short"
                  value={autoClickerOptions.delayMs}
                  min={0}
                  max={60000}
                  onChange={e => updateAutoClickerOptions({ delayMs: Number(e.target.value) })}
                  title="Delay after each click. Use 0 for the fastest inserted preset."
                />
              </>
            ) : (
              <>
                <label className="macro-label">CPS</label>
                <input
                  type="number"
                  className="macro-input macro-input--short"
                  value={autoClickerOptions.clicksPerSecond}
                  min={0.1}
                  max={10000}
                  step={0.1}
                  onChange={e => updateAutoClickerOptions({ clicksPerSecond: Number(e.target.value) })}
                  title="Target clicks per second for the inserted repeat block."
                />
                <span className="macro-preset-calculated" title="Target interval between click starts for this preset.">
                  {calculatedAutoClickerDelay} ms interval
                </span>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="macro-actions-list">
        {macro.actions.length === 0 && (
          <div className="empty-state">No actions yet. Add one above.</div>
        )}
        {macro.actions.map((action, idx) => {
          const decoration = pairDecorations.get(action.id);
          return (
          <div
            key={action.id}
            className={`action-wrapper${dropIndex === idx ? ' action-wrapper--drop-before' : ''}${dropIndex === idx + 1 ? ' action-wrapper--drop-after' : ''}${decoration ? ` action-wrapper--linked action-wrapper--linked-${decoration.role}${hoveredPairIndex === decoration.pairIndex ? ' action-wrapper--linked-hover' : ''}` : ''}`}
            style={actionPairStyle(decoration)}
            draggable
            onMouseEnter={() => setHoveredPairIndex(decoration?.pairIndex ?? null)}
            onMouseLeave={() => setHoveredPairIndex(null)}
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
              onChange={(updated, insertAfter) => updateAction(idx, updated, insertAfter)}
              onDelete={() => deleteAction(idx)}
              pairDecoration={actionPairRole(action) ? decoration : undefined}
            />
          </div>
          );
        })}
        {macro.actions.length > 0 ? <div className={`action-drop-end${dropIndex === macro.actions.length ? ' action-drop-end--active' : ''}`} /> : null}
      </div>
    </div>
  );
}
