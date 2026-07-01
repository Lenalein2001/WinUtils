import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { clipboard } from 'electron';
import type { IfAction, Macro, MacroAction, MacroCondition, RepeatAction } from '../shared/macro';

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
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  insert: 0x2d,
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
  if (low.length === 1) {
    const code = low.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) return code - 32; // a-z -> A-Z vk
    if (code >= 0x30 && code <= 0x39) return code; // 0-9
  }
  return 0;
}

function keysForString(keyStr: string): number[] {
  return keyStr.split('+').map(p => parseKey(p)).filter(k => k !== 0);
}

function buildVkArray(vks: number[]): string {
  return `[System.UInt16[]]@(${vks.join(',')})`;
}

function buildSendTextPwsh(text: string): string {
  // Unicode character injection via SendInput
  const escaped = text.replace(/'/g, "''");
  return `[void][WinAPI]::InjectText('${escaped}')`;
}

// Loaded once in a persistent PowerShell worker so game macros do not pay
// PowerShell startup and Add-Type compilation between input actions.
const PS_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WinAPI {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("winmm.dll")] private static extern uint timeBeginPeriod(uint period);
  [DllImport("winmm.dll")] private static extern uint timeEndPeriod(uint period);

  private const uint MAPVK_VK_TO_VSC_EX = 4;
  private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint KEYEVENTF_SCANCODE = 0x0008;
  private static bool timerResolutionRaised;

  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public INPUTUNION u;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra;
  }

  static WinAPI() {
    try {
      timerResolutionRaised = timeBeginPeriod(1) == 0;
      if (timerResolutionRaised) {
        AppDomain.CurrentDomain.ProcessExit += delegate { try { timeEndPeriod(1); } catch {} };
      }
    } catch {
      timerResolutionRaised = false;
    }
  }

  public static void Delay(int milliseconds) {
    if (milliseconds <= 0) return;
    if (milliseconds <= 2) {
      var sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < milliseconds) {
        System.Threading.Thread.SpinWait(64);
      }
      return;
    }
    System.Threading.Thread.Sleep(milliseconds);
  }

  private static bool IsExtendedKey(ushort vk, uint scanCode) {
    if ((scanCode & 0xFF00) != 0) return true;

    switch (vk) {
      case 0x21: // Page Up
      case 0x22: // Page Down
      case 0x23: // End
      case 0x24: // Home
      case 0x25: // Left
      case 0x26: // Up
      case 0x27: // Right
      case 0x28: // Down
      case 0x2D: // Insert
      case 0x2E: // Delete
      case 0x5B: // Left Win
      case 0x5C: // Right Win
      case 0x6F: // Numpad Divide
        return true;
      default:
        return false;
    }
  }

  private static INPUT CreateKeyInput(ushort vk, bool keyUp) {
    var scanCode = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
    var inp = new INPUT[1];
    inp[0].type = 1;
    if (scanCode != 0) {
      inp[0].u.ki.wScan = (ushort)(scanCode & 0xFF);
      inp[0].u.ki.dwFlags = KEYEVENTF_SCANCODE | (keyUp ? KEYEVENTF_KEYUP : 0) | (IsExtendedKey(vk, scanCode) ? KEYEVENTF_EXTENDEDKEY : 0);
    } else {
      inp[0].u.ki.wVk = vk;
      inp[0].u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
    }

    return inp[0];
  }

  private static void SendInputBatch(INPUT[] inputs) {
    if (inputs == null || inputs.Length == 0) return;
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void SendKey(ushort vk, uint flags) {
    var isKeyUp = (flags & KEYEVENTF_KEYUP) != 0;
    var inp = new INPUT[1];
    inp[0] = CreateKeyInput(vk, isKeyUp);
    SendInputBatch(inp);
  }

  public static void SendKeyCombo(ushort[] vks, int mode, int holdMs) {
    if (vks == null || vks.Length == 0) return;

    if (mode == 1) {
      var inputs = new INPUT[vks.Length];
      for (int i = 0; i < vks.Length; i++) inputs[i] = CreateKeyInput(vks[i], false);
      SendInputBatch(inputs);
      return;
    }

    if (mode == 2) {
      var inputs = new INPUT[vks.Length];
      for (int i = 0; i < vks.Length; i++) inputs[i] = CreateKeyInput(vks[vks.Length - 1 - i], true);
      SendInputBatch(inputs);
      return;
    }

    var downInputs = new INPUT[vks.Length];
    var upInputs = new INPUT[vks.Length];
    for (int i = 0; i < vks.Length; i++) {
      downInputs[i] = CreateKeyInput(vks[i], false);
      upInputs[i] = CreateKeyInput(vks[vks.Length - 1 - i], true);
    }
    SendInputBatch(downInputs);
    Delay(holdMs);
    SendInputBatch(upInputs);
  }

  public static void SendMouse(uint flags) {
    var inp = new INPUT[1];
    inp[0].type = 0;
    inp[0].u.mi.flags = flags;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void InjectText(string text) {
    foreach (char c in text) {
      var inps = new INPUT[2];
      inps[0].type = 1; inps[0].u.ki.wScan = c; inps[0].u.ki.dwFlags = 4;
      inps[1].type = 1; inps[1].u.ki.wScan = c; inps[1].u.ki.dwFlags = 6;
      SendInput(2, inps, Marshal.SizeOf(typeof(INPUT)));
      Delay(1);
    }
  }
  public static void MouseClick(uint down, uint up) {
    var inps = new INPUT[2];
    inps[0].type = 0;
    inps[0].u.mi.flags = down;
    inps[1].type = 0;
    inps[1].u.mi.flags = up;
    SendInput(2, inps, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void MouseDoubleClick(uint down, uint up) {
    MouseClick(down, up);
    Delay(50);
    MouseClick(down, up);
  }
  private static void DelayUntil(Stopwatch stopwatch, long targetTicks) {
    for (;;) {
      var remainingTicks = targetTicks - stopwatch.ElapsedTicks;
      if (remainingTicks <= 0) return;

      var remainingMs = (remainingTicks * 1000) / Stopwatch.Frequency;
      if (remainingMs > 2) {
        Delay((int)remainingMs - 1);
      } else {
        System.Threading.Thread.SpinWait(64);
      }
    }
  }

  public static void MouseClickLoop(uint down, uint up, int times, int delayMs) {
    if (delayMs <= 0) {
      for (int i = 0; i < times; i++) MouseClick(down, up);
      return;
    }

    var stopwatch = Stopwatch.StartNew();
    var intervalTicks = (long)delayMs * Stopwatch.Frequency / 1000;
    for (int i = 0; i < times; i++) {
      if (i > 0) DelayUntil(stopwatch, intervalTicks * i);
      MouseClick(down, up);
    }
  }
}
"@
`;

const PS_WORKER_SCRIPT = `${PS_HELPER}
$ErrorActionPreference = "Stop"
[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "__WINUTILS_EXIT__") { break }

  $space = $line.IndexOf(' ')
  if ($space -le 0) { continue }

  $requestId = $line.Substring(0, $space)
  $payload = $line.Substring($space + 1)

  try {
    $bytes = [Convert]::FromBase64String($payload)
    $code = [System.Text.Encoding]::UTF8.GetString($bytes)
    [scriptblock]::Create($code).Invoke() | Out-Null
    [Console]::Out.WriteLine("OK " + $requestId)
  } catch {
    $message = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
    [Console]::Out.WriteLine("ERR " + $requestId + " " + $message)
  }

  [Console]::Out.Flush()
}
`;

class MacroInputWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextRequestId = 1;
  private starting: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  async run(script: string): Promise<void> {
    await this.ensureStarted();

    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      this.child = null;
      throw new Error('Macro input worker is not available.');
    }

    const requestId = String(this.nextRequestId++);
    const payload = Buffer.from(script, 'utf8').toString('base64');

    await new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      child.stdin.write(`${requestId} ${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.rejectPending(new Error('Macro input worker stopped.'));

    if (!child || child.killed) return;
    child.stdin.write('__WINUTILS_EXIT__\n', () => {
      child.stdin.end();
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.ready) return;
    if (this.starting) return this.starting;

    this.ready = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.starting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = this.stderrBuffer.trim();
        const suffix = detail ? ` ${detail}` : '';
        const error = new Error(`Macro input worker did not become ready.${suffix}`);
        this.rejectReady?.(error);
        this.killCurrentWorker();
      }, 10_000);

      this.resolveReady = () => {
        clearTimeout(timer);
        this.ready = true;
        this.resolveReady = null;
        this.rejectReady = null;
        resolve();
      };
      this.rejectReady = (error) => {
        clearTimeout(timer);
        this.resolveReady = null;
        this.rejectReady = null;
        reject(error);
      };

      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_WORKER_SCRIPT], {
        windowsHide: true,
        stdio: 'pipe',
      });

      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
      child.stderr.on('data', (chunk: string) => {
        this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
      });
      child.once('error', (error) => {
        if (this.child === child) this.child = null;
        this.ready = false;
        this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      });
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        this.ready = false;
        const detail = this.stderrBuffer.trim();
        const suffix = detail ? ` ${detail}` : '';
        const error = new Error(`Macro input worker exited (${code ?? signal ?? 'unknown'}).${suffix}`);
        this.rejectReady?.(error);
        this.rejectPending(error);
      });
    });

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    for (;;) {
      const lineEnd = this.stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) return;

      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);

      if (line === 'READY') {
        this.resolveReady?.();
        continue;
      }

      this.handleResponse(line);
    }
  }

  private killCurrentWorker(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child && !child.killed) child.kill();
  }

  private handleResponse(line: string): void {
    const [status, requestId, encodedMessage] = line.split(' ');
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);

    if (status === 'OK') {
      pending.resolve();
      return;
    }

    const message = encodedMessage
      ? Buffer.from(encodedMessage, 'base64').toString('utf8')
      : 'Macro input worker failed.';
    pending.reject(new Error(message));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

interface ForegroundWindowInfo {
  processName: string;
  title: string;
}

const inputWorker = new MacroInputWorker();

export async function warmMacroExecutor(): Promise<void> {
  await inputWorker.warm();
}

export function stopMacroExecutor(): void {
  inputWorker.stop();
}

async function runPwsh(script: string): Promise<void> {
  await inputWorker.run(script);
}

async function runPwshBatch(parts: string[]): Promise<void> {
  if (parts.length === 0) return;
  await runPwsh(parts.join('\n'));
  parts.length = 0;
}

function mouseFlags(button: string): { down: number; up: number } {
  switch (button) {
    case 'right': return { down: 0x0008, up: 0x0010 };
    case 'middle': return { down: 0x0020, up: 0x0040 };
    default: return { down: 0x0002, up: 0x0004 };
  }
}

async function getForegroundWindowInfo(): Promise<ForegroundWindowInfo> {
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ForegroundHelper {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  public static string GetInfo() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return "\t";
    uint pid = 0;
    GetWindowThreadProcessId(hwnd, out pid);
    string processName = "";
    if (pid > 0) {
      try { processName = Process.GetProcessById((int)pid).ProcessName; } catch {}
    }
    string title = "";
    try {
      int length = GetWindowTextLength(hwnd);
      if (length > 0) {
        var sb = new StringBuilder(length + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        title = sb.ToString();
      }
    } catch {}
    return processName + "\t" + title;
  }
}
'@
[ForegroundHelper]::GetInfo()
`;

  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const [processName = '', title = ''] = stdout.trimEnd().split('\t');
  return { processName, title };
}

function compareConditionText(actual: string, condition: MacroCondition): boolean {
  if (!condition.value) return false;

  const expected = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
  const candidate = condition.caseSensitive ? actual : actual.toLowerCase();

  switch (condition.operator) {
    case 'contains': return candidate.includes(expected);
    case 'not-contains': return !candidate.includes(expected);
    case 'equals': return candidate === expected;
    case 'not-equals': return candidate !== expected;
    case 'matches': {
      try {
        return new RegExp(condition.value, condition.caseSensitive ? '' : 'i').test(actual);
      } catch {
        return false;
      }
    }
    case 'not-matches': {
      try {
        return !new RegExp(condition.value, condition.caseSensitive ? '' : 'i').test(actual);
      } catch {
        return true;
      }
    }
    default:
      return false;
  }
}

async function isKeyPressed(key: string): Promise<boolean> {
  const vks = keysForString(key);
  if (vks.length === 0) return false;

  const script = String.raw`
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class KeyStateHelper {
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
  public static bool ArePressed(int[] keys) {
    if (keys == null || keys.Length == 0) return false;
    foreach (int key in keys) {
      if ((GetAsyncKeyState(key) & unchecked((short)0x8000)) == 0) return false;
    }
    return true;
  }
}
'@
[KeyStateHelper]::ArePressed([int[]]@(${vks.join(',')}))
`;

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
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
  const milliseconds = Math.trunc(Number(value));
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

function appendInputAction(action: MacroAction, parts: string[]): boolean {
  switch (action.type) {
    case 'delay':
      parts.push(`[void][WinAPI]::Delay(${delayMilliseconds(action.milliseconds)})`);
      return true;

    case 'keyboard': {
      const vks = keysForString(action.key);
      if (vks.length === 0) return true;
      const mode = action.pressType === 'down' ? 1 : action.pressType === 'up' ? 2 : 0;
      parts.push(`[void][WinAPI]::SendKeyCombo((${buildVkArray(vks)}), ${mode}, 16)`);
      return true;
    }

    case 'mouse': {
      const { down, up } = mouseFlags(action.button);
      if (action.actionType === 'move' && action.x !== undefined && action.y !== undefined) {
        parts.push(`[void][WinAPI]::SetCursorPos(${action.x}, ${action.y})`);
      } else if (action.actionType === 'click') {
        parts.push(`[void][WinAPI]::MouseClick(${down}, ${up})`);
      } else if (action.actionType === 'double-click') {
        parts.push(`[void][WinAPI]::MouseDoubleClick(${down}, ${up})`);
      } else if (action.actionType === 'down') {
        parts.push(`[void][WinAPI]::SendMouse(${down})`);
      } else if (action.actionType === 'up') {
        parts.push(`[void][WinAPI]::SendMouse(${up})`);
      }
      return true;
    }

    case 'text':
      parts.push(buildSendTextPwsh(action.text));
      return true;

    default:
      return false;
  }
}

async function executeNonInputAction(action: MacroAction): Promise<void> {
  switch (action.type) {
    case 'delay':
    case 'keyboard':
    case 'mouse':
    case 'text':
    case 'repeat':
    case 'if':
      break;

    case 'launch': {
      const p = action.path.trim();
      if (!p) break;
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'ps1') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p,
          ...(action.arguments ? action.arguments.split(' ') : []),
        ]);
      } else if (ext === 'bat' || ext === 'cmd') {
        await execFileAsync('cmd.exe', ['/C', p, ...(action.arguments ? action.arguments.split(' ') : [])]);
      } else {
        execFile(p, action.arguments ? action.arguments.split(' ') : [], { shell: true }, () => {});
      }
      break;
    }

    case 'command': {
      const escaped = action.command.replace(/"/g, '\\"');
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-Command', `& { ${escaped} }`,
      ], { cwd: action.workingDirectory || process.cwd() });
      break;
    }
  }
}

function repeatTimes(value: number): number {
  const times = Math.trunc(Number(value));
  return Number.isFinite(times) ? Math.max(0, Math.min(10_000, times)) : 0;
}

function appendOptimizedRepeatAction(action: RepeatAction, parts: string[]): boolean {
  const enabledActions = action.actions.filter(nestedAction => nestedAction.enabled);
  if (enabledActions.length !== 1 && enabledActions.length !== 2) return false;

  const clickAction = enabledActions[0];
  if (clickAction?.type !== 'mouse' || clickAction.actionType !== 'click') return false;

  const delayAction = enabledActions[1];
  if (delayAction && delayAction.type !== 'delay') return false;

  const times = repeatTimes(action.times);
  if (times <= 0) return true;

  const { down, up } = mouseFlags(clickAction.button);
  const delayMs = delayAction?.type === 'delay' ? delayMilliseconds(delayAction.milliseconds) : 0;
  parts.push(`[void][WinAPI]::MouseClickLoop(${down}, ${up}, ${times}, ${delayMs})`);
  return true;
}

async function executeActions(actions: MacroAction[], inputBatch: string[]): Promise<void> {
  for (const action of actions) {
    if (!action.enabled) continue;

    if (action.type === 'repeat') {
      const repeatAction = action as RepeatAction;
      if (appendOptimizedRepeatAction(repeatAction, inputBatch)) continue;

      await runPwshBatch(inputBatch);
      const times = repeatTimes(repeatAction.times);
      for (let index = 0; index < times; index++) {
        await executeActions(repeatAction.actions, inputBatch);
      }
      continue;
    }

    if (action.type === 'if') {
      await runPwshBatch(inputBatch);
      const ifAction = action as IfAction;
      const branch = await evaluateCondition(ifAction.condition) ? ifAction.thenActions : ifAction.elseActions;
      await executeActions(branch, inputBatch);
      continue;
    }

    if (appendInputAction(action, inputBatch)) continue;

    await runPwshBatch(inputBatch);
    await executeNonInputAction(action);
  }
}

// ─── Public executor ───────────────────────────────────────────────────────

export async function executeMacro(macro: Macro): Promise<void> {
  const inputBatch: string[] = [];
  await executeActions(macro.actions, inputBatch);
  await runPwshBatch(inputBatch);
}
