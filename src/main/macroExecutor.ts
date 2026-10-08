import { testBoundedRegex } from './boundedRegex';
import { stopWorkerGracefully } from './workerLifecycle';
import { splitWindowsArguments } from './windowsArguments';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
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
using System.Text;
public static class WinAPI {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
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
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != (uint)inputs.Length) throw new InvalidOperationException("Windows accepted " + sent + " of " + inputs.Length + " input events. Check the target application's elevation and input restrictions.");
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
    SendInputBatch(inp);
  }
  public static bool AreKeysPressed(ushort[] keys) {
    if (keys == null || keys.Length == 0) return false;
    foreach (ushort key in keys) {
      if ((GetAsyncKeyState(key) & unchecked((short)0x8000)) == 0) return false;
    }
    return true;
  }
  public static string ForegroundInfo() {
    IntPtr hwnd = GetForegroundWindow();
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    string name = "";
    if (pid > 0) {
      try { using (Process process = Process.GetProcessById((int)pid)) { name = process.ProcessName; } } catch {}
    }
    StringBuilder title = new StringBuilder(32768);
    GetWindowText(hwnd, title, title.Capacity);
    return name + "\\t" + title.ToString();
  }
  public static void InjectText(string text) {
    foreach (char c in text) {
      var inps = new INPUT[2];
      inps[0].type = 1; inps[0].u.ki.wScan = c; inps[0].u.ki.dwFlags = 4;
      inps[1].type = 1; inps[1].u.ki.wScan = c; inps[1].u.ki.dwFlags = 6;
      SendInputBatch(inps);
      Delay(1);
    }
  }
  public static void MouseClick(uint down, uint up) {
    var inps = new INPUT[2];
    inps[0].type = 0;
    inps[0].u.mi.flags = down;
    inps[1].type = 0;
    inps[1].u.mi.flags = up;
    SendInputBatch(inps);
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
    $result = [scriptblock]::Create($code).Invoke()
    $output = if ($null -eq $result) { "" } else { ($result | Out-String).TrimEnd() }
    $encodedOutput = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($output))
    [Console]::Out.WriteLine("OK " + $requestId + " " + $encodedOutput)
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
  private readonly pending = new Map<string, { resolve: (output: string) => void; reject: (error: Error) => void }>();

  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  async run(script: string): Promise<void> {
    await this.runForOutput(script);
  }

  async runForOutput(script: string): Promise<string> {
    await this.ensureStarted();

    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      this.child = null;
      throw new Error('Macro input worker is not available.');
    }

    const requestId = String(this.nextRequestId++);
    const payload = Buffer.from(script, 'utf8').toString('base64');

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Macro input worker timed out.'));
        this.killCurrentWorker();
      }, 30_000);
      this.pending.set(requestId, {
        resolve: output => { clearTimeout(timer); resolve(output); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${requestId} ${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.rejectPending(new Error('Macro input worker stopped.'));

    if (!child || child.killed) return;
    await stopWorkerGracefully(child, () => new Promise<void>((resolve, reject) => {
      child.stdin.write('__WINUTILS_EXIT__\n', error => error ? reject(error) : resolve());
    }));
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
        if (this.child !== child) return;
        this.child = null;
        this.ready = false;
        this.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
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
    this.rejectPending(new Error('Macro input worker stopped.'));
    if (child && !child.killed) child.kill();
  }

  private handleResponse(line: string): void {
    const [status, requestId, encodedMessage] = line.split(' ');
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);

    if (status === 'OK') {
      pending.resolve(encodedMessage ? Buffer.from(encodedMessage, 'base64').toString('utf8') : '');
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
const MAX_ACTION_EXECUTIONS = 100_000;
const MAX_CONTROL_FLOW_DEPTH = 32;

class MacroControlFlowSignal extends Error {}
class MacroCanceledSignal extends MacroControlFlowSignal {}
class MacroStoppedSignal extends MacroControlFlowSignal {}
export type MacroExecutionResult = 'completed' | 'canceled' | 'stopped';

interface MacroExecutionContext {
  signal: AbortSignal;
  shouldCancel?: () => boolean;
  actionExecutions: number;
  heldKeys: Set<number>;
  heldMouseButtons: Map<string, number>;
}

const KEY_STATE_MONITOR_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinUtilsKeyStateMonitor {
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
  public static string GetPressedKeys() {
    StringBuilder builder = new StringBuilder();
    for (int key = 1; key <= 254; key++) {
      if ((GetAsyncKeyState(key) & unchecked((short)0x8000)) == 0) continue;
      if (builder.Length > 0) builder.Append(',');
      builder.Append(key);
    }
    return builder.ToString();
  }
}
'@

while ($true) {
  [Console]::Out.WriteLine("KEYS " + [WinUtilsKeyStateMonitor]::GetPressedKeys())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 20
}
`;

class MacroKeyStateMonitor {
  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private readonly pressedKeys = new Set<number>();
  private updatedAt = 0;

  start(): void {
    if (this.child && !this.child.killed) return;

    this.stdoutBuffer = '';
    this.updatedAt = 0;
    this.pressedKeys.clear();

    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', KEY_STATE_MONITOR_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(chunk));
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });
    child.once('error', () => {
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = '';
    this.updatedAt = 0;
    this.pressedKeys.clear();
    if (child && !child.killed) child.kill();
  }

  arePressed(vks: number[]): boolean | null {
    if (Date.now() - this.updatedAt > 250) return null;
    return vks.length > 0 && vks.every(vk => this.pressedKeys.has(vk));
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    for (;;) {
      const lineEnd = this.stdoutBuffer.indexOf('\n');
      if (lineEnd < 0) return;

      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (!line.startsWith('KEYS')) continue;

      this.pressedKeys.clear();
      const keys = line.slice('KEYS'.length).trim();
      if (keys) {
        for (const rawKey of keys.split(',')) {
          const key = Number(rawKey);
          if (Number.isFinite(key)) this.pressedKeys.add(key);
        }
      }
      this.updatedAt = Date.now();
    }
  }
}

const keyStateMonitor = new MacroKeyStateMonitor();

export async function warmMacroExecutor(): Promise<void> {
  keyStateMonitor.start();
  await inputWorker.warm();
}

export async function stopMacroExecutor(): Promise<void> {
  keyStateMonitor.stop();
  await inputWorker.stop();
}

async function runPwsh(script: string): Promise<void> {
  await inputWorker.run(script);
}

async function runPwshOutput(script: string): Promise<string> {
  return inputWorker.runForOutput(script);
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

function trackHeldInput(action: MacroAction, context: MacroExecutionContext): void {
  if (action.type === 'keyboard') {
    const keys = keysForString(action.key);
    if (action.pressType === 'down') keys.forEach(key => context.heldKeys.add(key));
    if (action.pressType === 'up') keys.forEach(key => context.heldKeys.delete(key));
    return;
  }
  if (action.type !== 'mouse') return;
  const flags = mouseFlags(action.button);
  if (action.actionType === 'down') context.heldMouseButtons.set(action.button, flags.up);
  if (action.actionType === 'up') context.heldMouseButtons.delete(action.button);
}

async function releaseHeldInputs(context: MacroExecutionContext): Promise<void> {
  const releases = [
    ...[...context.heldKeys].reverse().map(key => `[void][WinAPI]::SendKeyCombo((${buildVkArray([key])}), 2, 0)`),
    ...[...context.heldMouseButtons.values()].map(flag => `[void][WinAPI]::SendMouse(${flag})`),
  ];
  context.heldKeys.clear();
  context.heldMouseButtons.clear();
  if (releases.length > 0) await runPwsh(releases.join('\n'));
}

async function getForegroundWindowInfo(): Promise<ForegroundWindowInfo> {
  // Read current focus in the warmed worker rather than starting and compiling
  // a separate PowerShell process for every conditional macro action.
  const output = await runPwshOutput('[WinAPI]::ForegroundInfo()');
  const separator = output.indexOf('\t');
  const processName = separator < 0 ? output : output.slice(0, separator);
  const title = separator < 0 ? '' : output.slice(separator + 1);
  return { processName, title };
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

  const monitoredState = keyStateMonitor.arePressed(vks);
  if (monitoredState === true) return true;

  try {
    const output = await runPwshOutput(`[WinAPI]::AreKeysPressed((${buildVkArray(vks)}))`);
    return output.trim().toLowerCase() === 'true';
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

async function executeActions(
  actions: MacroAction[],
  inputBatch: string[],
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
    if (context.actionExecutions > MAX_ACTION_EXECUTIONS) {
      throw new Error(`Macro exceeded the ${MAX_ACTION_EXECUTIONS.toLocaleString()} action execution safety limit.`);
    }

    if (action.type === 'stop') {
      await runPwshBatch(inputBatch);
      throw new MacroStoppedSignal();
    }

    if (action.type === 'delay' && context.shouldCancel && delayMilliseconds(action.milliseconds) > 25) {
      await runPwshBatch(inputBatch);
      await waitWithCancellation(delayMilliseconds(action.milliseconds), context);
      continue;
    }

    if (action.type === 'repeat') {
      const repeatAction = action as RepeatAction;
      if (!context.shouldCancel && appendOptimizedRepeatAction(repeatAction, inputBatch)) continue;

      await runPwshBatch(inputBatch);
      const times = repeatTimes(repeatAction.times);
      for (let index = 0; index < times; index++) {
        assertMacroCanContinue(context);
        await executeActions(repeatAction.actions, inputBatch, runAutomationAction, context, depth + 1);
        if (context.shouldCancel) await runPwshBatch(inputBatch);
      }
      continue;
    }

    if (action.type === 'if') {
      await runPwshBatch(inputBatch);
      const ifAction = action as IfAction;
      const branch = await evaluateCondition(ifAction.condition) ? ifAction.thenActions : ifAction.elseActions;
      await executeActions(branch, inputBatch, runAutomationAction, context, depth + 1);
      continue;
    }

    function assertMacroCanContinue(context: MacroExecutionContext): void {
      if (context.shouldCancel?.()) throw new MacroCanceledSignal();
    }

    async function waitWithCancellation(milliseconds: number, context: MacroExecutionContext): Promise<void> {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        assertMacroCanContinue(context);
        await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      }
    }

    if (appendInputAction(action, inputBatch)) {
      trackHeldInput(action, context);
      continue;
    }

    await runPwshBatch(inputBatch);
    await executeNonInputAction(action, runAutomationAction, context.signal);
  }
}

// ─── Public executor ───────────────────────────────────────────────────────

export async function executeMacro(
  macro: Macro,
  runAutomationAction?: MacroAutomationActionRunner,
  shouldCancel?: () => boolean,
): Promise<MacroExecutionResult> {
  const inputBatch: string[] = [];
  const controller = new AbortController();
  const cancellation = shouldCancel ? setInterval(() => { if (shouldCancel()) controller.abort(); }, 25) : undefined;
  const context: MacroExecutionContext = {
    signal: controller.signal,
    shouldCancel,
    actionExecutions: 0,
    heldKeys: new Set(),
    heldMouseButtons: new Map(),
  };
  try {
    await executeActions(macro.actions, inputBatch, runAutomationAction, context);
    await runPwshBatch(inputBatch);
    return 'completed';
  } catch (error) {
    if (controller.signal.aborted) return 'canceled';
    if (error instanceof MacroStoppedSignal) return 'stopped';
    if (error instanceof MacroCanceledSignal) return 'canceled';
    throw error;
  } finally {
    clearInterval(cancellation);
    await releaseHeldInputs(context);
  }
}
