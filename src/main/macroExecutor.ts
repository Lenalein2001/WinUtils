import { execFile } from 'node:child_process';
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

// ─── PowerShell input injection helper ─────────────────────────────────────

function buildSendInputPwsh(vks: number[], down: boolean): string {
  const flag = down ? '0' : '2'; // 0 = KEYDOWN, 2 = KEYUP
  return vks
    .map(vk => `[void][WinAPI]::SendKey(${vk}, ${flag})`)
    .join('; ');
}

function buildSendTextPwsh(text: string): string {
  // Unicode character injection via SendInput
  const escaped = text.replace(/'/g, "''");
  return `[void][WinAPI]::InjectText('${escaped}')`;
}

// We use a single persistent PowerShell helper script loaded inline for performance.
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

async function runPwsh(script: string): Promise<void> {
  const full = PS_HELPER + '\n' + script;
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', full,
  ]);
}

function mouseFlags(button: string): { down: number; up: number } {
  switch (button) {
    case 'right': return { down: 0x0008, up: 0x0010 };
    case 'middle': return { down: 0x0020, up: 0x0040 };
    default: return { down: 0x0002, up: 0x0004 };
  }
}

// ─── Action executor ───────────────────────────────────────────────────────

async function executeAction(action: MacroAction): Promise<void> {
  switch (action.type) {
    case 'delay':
      await new Promise(res => setTimeout(res, action.milliseconds));
      break;

    case 'keyboard': {
      const vks = keysForString(action.key);
      if (vks.length === 0) break;
      let script = '';
      if (action.pressType === 'press' || action.pressType === 'down') {
        script += vks.map(v => `[void][WinAPI]::SendKey(${v}, 0)`).join('; ') + '; ';
      }
      if (action.pressType === 'press' || action.pressType === 'up') {
        script += [...vks].reverse().map(v => `[void][WinAPI]::SendKey(${v}, 2)`).join('; ');
      }
      await runPwsh(script);
      break;
    }

    case 'mouse': {
      const { down, up } = mouseFlags(action.button);
      if (action.actionType === 'move' && action.x !== undefined && action.y !== undefined) {
        await runPwsh(`[void][WinAPI]::SetCursorPos(${action.x}, ${action.y})`);
      } else if (action.actionType === 'click') {
        await runPwsh(`[void][WinAPI]::MouseClick(${down}, ${up})`);
      } else if (action.actionType === 'double-click') {
        await runPwsh(`[void][WinAPI]::MouseDoubleClick(${down}, ${up})`);
      } else if (action.actionType === 'down') {
        await runPwsh(`[void][WinAPI]::mouse_event(${down}, 0, 0, 0, 0)`);
      } else if (action.actionType === 'up') {
        await runPwsh(`[void][WinAPI]::mouse_event(${up}, 0, 0, 0, 0)`);
      }
      break;
    }

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

    case 'text':
      await runPwsh(buildSendTextPwsh(action.text));
      break;
  }
}

// ─── Public executor ───────────────────────────────────────────────────────

export async function executeMacro(macro: Macro): Promise<void> {
  for (const action of macro.actions) {
    if (action.enabled) await executeAction(action);
  }
}
