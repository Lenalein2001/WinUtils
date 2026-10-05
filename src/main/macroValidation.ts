import type { Macro, MacroAction, MacroConfig, MacroProfile } from '../shared/macro';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid macro document.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maximum = 32768): void {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new Error(`Invalid macro ${field}.`);
}
function choice(value: unknown, field: string, values: string[]): void {
  if (!values.includes(String(value))) throw new Error(`Invalid macro ${field}.`);
}
function integer(value: unknown, field: string, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid macro ${field}.`);
}
export function validateActions(value: unknown): asserts value is MacroAction[] {
  let count = 0;
  const walk = (actions: unknown, depth: number): void => {
    if (!Array.isArray(actions) || actions.length > 10000 || depth > 8) throw new Error('Macro nesting or action budget exceeded.');
    for (const value of actions) {
      if (++count > 10000) throw new Error('Macro action budget exceeded.');
      const action = record(value); text(action.id, 'action id', 128);
      if (typeof action.enabled !== 'boolean') throw new Error('Invalid macro action enabled flag.');
      switch (action.type) {
        case 'delay': integer(action.milliseconds, 'delay', 0, 600000); break;
        case 'keyboard': text(action.key, 'key', 128); choice(action.pressType, 'key action', ['press', 'down', 'up']); break;
        case 'mouse':
          choice(action.button, 'mouse button', ['left', 'right', 'middle']);
          choice(action.actionType, 'mouse action', ['click', 'double-click', 'down', 'up', 'move']);
          for (const key of ['x', 'y']) if (action[key] !== undefined) integer(action[key], 'mouse coordinate', -1000000, 1000000);
          break;
        case 'launch': text(action.path, 'launch path'); if (action.arguments !== undefined) text(action.arguments, 'arguments'); break;
        case 'command': text(action.command, 'command'); if (action.workingDirectory !== undefined) text(action.workingDirectory, 'working directory'); break;
        case 'text': text(action.text, 'text', 500000); break;
        case 'automation':
          text(action.actionId, 'automation id', 512);
          if (action.parameters !== undefined) {
            const parameters = record(action.parameters);
            if (Object.keys(parameters).length > 100) throw new Error('Macro parameter budget exceeded.');
            for (const parameter of Object.values(parameters)) {
              if (typeof parameter === 'string') text(parameter, 'parameter', 500000);
              else if (typeof parameter !== 'boolean' && !(typeof parameter === 'number' && Number.isFinite(parameter))) throw new Error('Invalid macro parameter.');
            }
          }
          break;
        case 'repeat': integer(action.times, 'repeat count', 1, 10000); walk(action.actions, depth + 1); break;
        case 'if': {
          const condition = record(action.condition);
          choice(condition.source, 'condition source', ['active-process', 'active-window-title', 'clipboard-text', 'file-exists', 'key-state']);
          choice(condition.operator, 'condition operator', ['contains', 'equals', 'matches', 'not-contains', 'not-equals', 'not-matches', 'exists', 'not-exists', 'is-pressed', 'is-not-pressed']);
          text(condition.value, 'condition');
          if (typeof condition.caseSensitive !== 'boolean') throw new Error('Invalid condition case sensitivity.');
          walk(action.thenActions, depth + 1); walk(action.elseActions, depth + 1); break;
        }
        case 'stop': break;
        default: throw new Error('Unsupported macro action.');
      }
    }
  };
  walk(value, 0);
}
export function validateMacro(value: unknown): asserts value is Macro {
  const macro = record(value); text(macro.id, 'id', 128); text(macro.name, 'name', 512); text(macro.hotkey, 'hotkey', 128);
  if (typeof macro.enabled !== 'boolean' || (macro.hotkeyEnabled !== undefined && typeof macro.hotkeyEnabled !== 'boolean')) throw new Error('Invalid macro enabled flag.');
  validateActions(macro.actions);
}
export function validateProfile(value: unknown): asserts value is MacroProfile {
  const profile = record(value); text(profile.name, 'profile name', 512);
  if (!Array.isArray(profile.macros) || profile.macros.length > 1000 || !Array.isArray(profile.folders) || profile.folders.length > 200) throw new Error('Invalid macro profile collections.');
  const ids = new Set<string>();
  const check = (macro: unknown): void => { validateMacro(macro); if (ids.has(macro.id)) throw new Error('Duplicate macro id.'); ids.add(macro.id); };
  profile.macros.forEach(check);
  const folderIds = new Set<string>();
  for (const value of profile.folders) {
    const folder = record(value); text(folder.id, 'folder id', 128); text(folder.name, 'folder name', 512);
    if (folderIds.has(folder.id as string)) throw new Error('Duplicate macro folder id.');
    folderIds.add(folder.id as string);
    if (!Array.isArray(folder.macros) || folder.macros.length > 1000) throw new Error('Invalid macro folder.');
    folder.macros.forEach(check);
  }
  if (profile.processBindings !== undefined) {
    if (!Array.isArray(profile.processBindings) || profile.processBindings.length > 128) throw new Error('Invalid macro process bindings.');
    profile.processBindings.forEach(value => text(value, 'process binding'));
  }
}
export function validateConfig(value: unknown): asserts value is MacroConfig {
  const config = record(value); text(config.activeProfile, 'active profile', 512);
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 64) throw new Error('Invalid macro profiles.');
  config.profiles.forEach(validateProfile);
  if (new Set(config.profiles.map(profile => profile.name)).size !== config.profiles.length) throw new Error('Duplicate macro profile name.');
  if (!config.profiles.some(profile => profile.name === config.activeProfile)) throw new Error('Active macro profile no longer exists.');
}
