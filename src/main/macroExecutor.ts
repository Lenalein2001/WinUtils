import { testBoundedRegex } from './boundedRegex';
import { nativeMacroWorker as inputWorker, NativeMacroCanceled, NativeMacroStopped, type NativeInputInstruction } from './nativeMacroWorker';
import { randomUUID } from 'node:crypto';
import { splitWindowsArguments } from './windowsArguments';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { clipboard } from 'electron';
import type { IfAction, Macro, MacroAction, MacroCondition, RepeatAction } from '../shared/macro';
import type { AutomationActionRequest } from '../shared/actions';

const execFileAsync = promisify(execFile);

// ─── Virtual key map (matches ScriptFlow's ParseKeyString) ─────────────────

const VK_MAP: Record<string, number> = {
  ctrl: 0x11, control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b, windows: 0x5b,
  enter: 0x0d, return: 0x0d,
  tab: 0x09,
  space: 0x20,
  escape: 0x1b, esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e, del: 0x2e,
  up: 0x26, arrowup: 0x26,
  down: 0x28, arrowdown: 0x28,
  left: 0x25, arrowleft: 0x25,
  right: 0x27, arrowright: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  insert: 0x2d,
  capslock: 0x14, 'caps-lock': 0x14, scrolllock: 0x91, 'scroll-lock': 0x91,
  printscreen: 0x2c, 'print-screen': 0x2c, pause: 0x13,
  oem5: 0xdc,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  num0: 0x60, numpad0: 0x60,
  num1: 0x61, numpad1: 0x61,
  num2: 0x62, numpad2: 0x62,
  num3: 0x63, numpad3: 0x63,
  num4: 0x64, numpad4: 0x64,
  num5: 0x65, numpad5: 0x65,
  num6: 0x66, numpad6: 0x66,
  num7: 0x67, numpad7: 0x67,
  num8: 0x68, numpad8: 0x68,
  num9: 0x69, numpad9: 0x69,
  nummult: 0x6a, nummultiply: 0x6a, numpadmultiply: 0x6a,
  numadd: 0x6b, numpadadd: 0x6b,
  numsub: 0x6d, numsubtract: 0x6d, numpadsubtract: 0x6d,
  numdec: 0x6e, numdecimal: 0x6e, numpaddecimal: 0x6e,
  numdiv: 0x6f, numdivide: 0x6f, numpaddivide: 0x6f,
  numlock: 0x90,
  '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, '\\': 0xdc,
  ';': 0xba, "'": 0xde, '`': 0xc0, ',': 0xbc, '.': 0xbe, '/': 0xbf,
};

function parseKey(part: string): number {
  const low = part.trim().toLowerCase();
  if (VK_MAP[low] !== undefined) return VK_MAP[low];
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(low);
  if (functionKey) return 0x6f + Number(functionKey[1]);
  if (low.length === 1) {
    const code = low.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) return code - 32; // a-z -> A-Z vk
    if (code >= 0x30 && code <= 0x39) return code; // 0-9
  }
  return 0;
}

function keysForString(keyStr: string): number[] {
  const keys = keyStr.split('+').map(p => parseKey(p));
  if (!keys.length || keys.some(key => key === 0)) throw new Error(`Unsupported macro key: ${keyStr}`);
  return keys;
}

const MAX_ACTION_EXECUTIONS = 100_000;
const MAX_CONTROL_FLOW_DEPTH = 8;

class MacroControlFlowSignal extends Error {}
class MacroCanceledSignal extends MacroControlFlowSignal {}
class MacroStoppedSignal extends MacroControlFlowSignal {}
export type MacroExecutionResult = 'completed' | 'canceled' | 'stopped';

interface MacroExecutionContext {
  signal: AbortSignal;
  runId: string;
  shouldCancel?: () => boolean;
  actionExecutions: number;
  nativeExecutions: number;
}

export async function warmMacroExecutor(): Promise<void> { await inputWorker.warm(); }
export async function stopMacroExecutor(): Promise<void> { await inputWorker.stop(); }

async function runInputBatch(parts: NativeInputInstruction[], context: MacroExecutionContext): Promise<void> {
  if (!parts.length) return;
  assertMacroCanContinue(context);
  context.nativeExecutions = await inputWorker.run(parts, context.runId, context.signal, MAX_ACTION_EXECUTIONS - context.actionExecutions);
  parts.length = 0;
}

function mouseFlags(button: string): { down: number; up: number } {
  return button === 'right' ? { down: 8, up: 16 } : button === 'middle' ? { down: 32, up: 64 } : { down: 2, up: 4 };
}

async function getForegroundWindowInfo(): Promise<{ processName: string; title: string }> {
  const output = await inputWorker.request({ op: 'foreground' });
  const separator = output.indexOf('\t');
  return { processName: separator < 0 ? output : output.slice(0, separator), title: separator < 0 ? '' : output.slice(separator + 1) };
}

async function compareConditionText(actual: string, condition: MacroCondition): Promise<boolean> {
  if (!condition.value) return false;

  const expected = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
  const candidate = condition.caseSensitive ? actual : actual.toLowerCase();

  switch (condition.operator) {
    case 'contains': return candidate.includes(expected);
    case 'not-contains': return !candidate.includes(expected);
    case 'equals': return candidate === expected;
    case 'not-equals': return candidate !== expected;
    case 'matches': return testBoundedRegex(condition.value, actual, Boolean(condition.caseSensitive));
    case 'not-matches': return !(await testBoundedRegex(condition.value, actual, Boolean(condition.caseSensitive)));
    default:
      return false;
  }
}

async function isKeyPressed(key: string): Promise<boolean> {
  const vks = keysForString(key);
  if (vks.length === 0) return false;

  const output = await inputWorker.request({ op: 'keys', keys: vks });
  return output.trim().toLowerCase() === 'true';
}

async function evaluateCondition(condition: MacroCondition): Promise<boolean> {
  if (condition.source === 'key-state') {
    const pressed = await isKeyPressed(condition.value);
    return condition.operator === 'is-not-pressed' ? !pressed : pressed;
  }

  if (condition.source === 'file-exists') {
    const path = condition.value.trim();
    if (!path) return condition.operator === 'not-exists';
    const exists = existsSync(path);
    return condition.operator === 'not-exists' ? !exists : exists;
  }

  if (condition.source === 'clipboard-text') {
    return compareConditionText(clipboard.readText(), condition);
  }

  const foreground = await getForegroundWindowInfo();
  if (condition.source === 'active-process') {
    return compareConditionText(foreground.processName, condition);
  }

  return compareConditionText(foreground.title, condition);
}

// ─── Action executor ───────────────────────────────────────────────────────

function delayMilliseconds(value: number): number {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 600_000) throw new Error('Invalid macro delay.');
  return milliseconds;
}

function inputInstruction(action: MacroAction): NativeInputInstruction | null {
  switch (action.type) {
    case 'delay': return { kind: 'delay', ms: delayMilliseconds(action.milliseconds) };
    case 'keyboard': return { kind: 'keyboard', keys: keysForString(action.key), mode: action.pressType === 'down' ? 1 : action.pressType === 'up' ? 2 : 0, holdMs: delayMilliseconds(action.holdMilliseconds ?? 16) };
    case 'mouse': {
      const flags = mouseFlags(action.button);
      if (action.actionType === 'move') {
        if (action.x === undefined || action.y === undefined) throw new Error('Mouse movement requires both coordinates.');
        return { kind: 'move', x: action.x, y: action.y };
      }
      return { kind: 'mouse', ...flags, mode: action.actionType === 'down' ? 1 : action.actionType === 'up' ? 2 : action.actionType === 'double-click' ? 3 : 0 };
    }
    case 'text': return { kind: 'text', text: action.text };
    case 'stop': return { kind: 'stop' };
    default: return null;
  }
}

export function compileInputActions(actions: MacroAction[], depth = 0): NativeInputInstruction[] | null {
  if (depth > MAX_CONTROL_FLOW_DEPTH) throw new Error('Macro nesting budget exceeded.');
  const result: NativeInputInstruction[] = [];
  for (const action of actions) {
    if (!action.enabled) continue;
    if (action.type === 'repeat') {
      const nested = compileInputActions(action.actions, depth + 1);
      if (!nested) return null;
      result.push({ kind: 'repeat', times: repeatTimes(action.times), actions: nested });
    } else {
      const instruction = inputInstruction(action);
      if (!instruction) return null;
      result.push(instruction);
    }
  }
  return result;
}

export type MacroAutomationActionRunner = (request: AutomationActionRequest) => Promise<void>;

async function executeNonInputAction(
  action: MacroAction,
  runAutomationAction?: MacroAutomationActionRunner,
  signal?: AbortSignal,
): Promise<void> {
  switch (action.type) {
    case 'delay':
    case 'keyboard':
    case 'mouse':
    case 'text':
    case 'repeat':
    case 'if':
    case 'stop':
      break;

    case 'launch': {
      const p = action.path.trim();
      if (!p) break;
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'ps1') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p,
          ...(splitWindowsArguments(action.arguments ?? '')),
        ], { signal, timeout: 30_000, windowsHide: true });
      } else if (ext === 'bat' || ext === 'cmd') {
        await execFileAsync('cmd.exe', ['/C', p, ...(splitWindowsArguments(action.arguments ?? ''))], { signal, timeout: 30_000, windowsHide: true });
      } else {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(p, splitWindowsArguments(action.arguments ?? ''), { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      }
      break;
    }

    case 'command': {
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', action.command,
      ], { cwd: action.workingDirectory || process.cwd(), signal, timeout: 30_000, windowsHide: true });
      break;
    }

    case 'automation': {
      if (!action.actionId) throw new Error('Automation action is not configured.');
      if (!runAutomationAction) throw new Error(`Automation action "${action.actionId}" cannot run in this context.`);
      await runAutomationAction({
        actionId: action.actionId,
        parameters: action.parameters,
      });
      break;
    }
  }
}

function repeatTimes(value: number): number {
  const times = Math.trunc(Number(value));
  return Number.isFinite(times) ? Math.max(0, Math.min(10_000, times)) : 0;
}

async function executeActions(
  actions: MacroAction[],
  inputBatch: NativeInputInstruction[],
  runAutomationAction: MacroAutomationActionRunner | undefined,
  context: MacroExecutionContext,
  depth = 0,
): Promise<void> {
  if (depth > MAX_CONTROL_FLOW_DEPTH) {
    throw new Error(`Macro nesting cannot exceed ${MAX_CONTROL_FLOW_DEPTH} levels.`);
  }
  for (const action of actions) {
    if (!action.enabled) continue;
    assertMacroCanContinue(context);
    context.actionExecutions += 1;
    if (context.actionExecutions + context.nativeExecutions > MAX_ACTION_EXECUTIONS) {
      throw new Error(`Macro exceeded the ${MAX_ACTION_EXECUTIONS.toLocaleString()} action execution safety limit.`);
    }

    if (action.type === 'stop') {
      await runInputBatch(inputBatch, context);
      throw new MacroStoppedSignal();
    }

    if (action.type === 'repeat') {
      const repeatAction = action as RepeatAction;
      const compiled = compileInputActions(repeatAction.actions, depth + 1);
      if (compiled) { context.actionExecutions--; inputBatch.push({ kind: 'repeat', times: repeatTimes(repeatAction.times), actions: compiled }); continue; }

      await runInputBatch(inputBatch, context);
      const times = repeatTimes(repeatAction.times);
      for (let index = 0; index < times; index++) {
        assertMacroCanContinue(context);
        await executeActions(repeatAction.actions, inputBatch, runAutomationAction, context, depth + 1);
        if (context.shouldCancel) await runInputBatch(inputBatch, context);
      }
      continue;
    }

    if (action.type === 'if') {
      await runInputBatch(inputBatch, context);
      const ifAction = action as IfAction;
      const branch = await evaluateCondition(ifAction.condition) ? ifAction.thenActions : ifAction.elseActions;
      await executeActions(branch, inputBatch, runAutomationAction, context, depth + 1);
      continue;
    }

    const instruction = inputInstruction(action);
    if (instruction) { context.actionExecutions--; inputBatch.push(instruction); continue; }

    await runInputBatch(inputBatch, context);
    await executeNonInputAction(action, runAutomationAction, context.signal);
  }
}

function assertMacroCanContinue(context: MacroExecutionContext): void {
  if (context.signal.aborted || context.shouldCancel?.()) throw new MacroCanceledSignal();
}

// ─── Public executor ───────────────────────────────────────────────────────

export async function executeMacro(
  macro: Macro,
  runAutomationAction?: MacroAutomationActionRunner,
  shouldCancel?: () => boolean,
): Promise<MacroExecutionResult> {
  const inputBatch: NativeInputInstruction[] = [];
  const controller = new AbortController();
  const cancellation = shouldCancel ? setInterval(() => { if (shouldCancel()) controller.abort(); }, 25) : undefined;
  const context: MacroExecutionContext = {
    signal: controller.signal,
    shouldCancel,
    actionExecutions: 0,
    nativeExecutions: 0,
    runId: randomUUID(),
  };
  try {
    await executeActions(macro.actions, inputBatch, runAutomationAction, context);
    await runInputBatch(inputBatch, context);
    return 'completed';
  } catch (error) {
    if (controller.signal.aborted) return 'canceled';
    if (error instanceof MacroStoppedSignal || error instanceof NativeMacroStopped) return 'stopped';
    if (error instanceof MacroCanceledSignal || error instanceof NativeMacroCanceled) return 'canceled';
    throw error;
  } finally {
    clearInterval(cancellation);
    await inputWorker.release(context.runId);
  }
}
