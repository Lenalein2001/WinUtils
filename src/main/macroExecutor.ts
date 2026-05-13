import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { Macro, MacroAction } from '../shared/macro';

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
using System.Runtime.InteropServices;
public static class WinAPI {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);

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

  public static void SendKey(ushort vk, uint flags) {
    var inp = new INPUT[1];
    inp[0].type = 1;
    inp[0].u.ki.wVk = vk;
    inp[0].u.ki.dwFlags = flags;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(1);
  }
  public static void InjectText(string text) {
    foreach (char c in text) {
      var inps = new INPUT[2];
      inps[0].type = 1; inps[0].u.ki.wScan = c; inps[0].u.ki.dwFlags = 4;
      inps[1].type = 1; inps[1].u.ki.wScan = c; inps[1].u.ki.dwFlags = 6;
      SendInput(2, inps, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(1);
    }
  }
  public static void MouseClick(uint down, uint up) {
    mouse_event(down, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(10);
    mouse_event(up, 0, 0, 0, 0);
  }
  public static void MouseDoubleClick(uint down, uint up) {
    MouseClick(down, up);
    System.Threading.Thread.Sleep(50);
    MouseClick(down, up);
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

// ─── Action executor ───────────────────────────────────────────────────────

function delayMilliseconds(value: number): number {
  const milliseconds = Math.trunc(Number(value));
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

function appendInputAction(action: MacroAction, parts: string[]): boolean {
  switch (action.type) {
    case 'delay':
      parts.push(`[System.Threading.Thread]::Sleep(${delayMilliseconds(action.milliseconds)})`);
      return true;

    case 'keyboard': {
      const vks = keysForString(action.key);
      if (vks.length === 0) return true;
      let script = '';
      if (action.pressType === 'press' || action.pressType === 'down') {
        script += vks.map(v => `[void][WinAPI]::SendKey(${v}, 0)`).join('; ') + '; ';
      }
      if (action.pressType === 'press' || action.pressType === 'up') {
        script += [...vks].reverse().map(v => `[void][WinAPI]::SendKey(${v}, 2)`).join('; ');
      }
      parts.push(script);
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
        parts.push(`[void][WinAPI]::mouse_event(${down}, 0, 0, 0, 0)`);
      } else if (action.actionType === 'up') {
        parts.push(`[void][WinAPI]::mouse_event(${up}, 0, 0, 0, 0)`);
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

// ─── Public executor ───────────────────────────────────────────────────────

export async function executeMacro(macro: Macro): Promise<void> {
  const inputBatch: string[] = [];

  for (const action of macro.actions) {
    if (!action.enabled) continue;
    if (appendInputAction(action, inputBatch)) continue;

    await runPwshBatch(inputBatch);
    await executeNonInputAction(action);
  }

  await runPwshBatch(inputBatch);
}
