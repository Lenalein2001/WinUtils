import { automationSignal } from './actionContext';
import { splitWindowsArguments } from './windowsArguments';
import { clipboard, Notification, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ActionEngine, AutomationActionRegistration } from './actionEngine';
import type { FocusAudioManager } from './focusAudioManager';

const execFileAsync = promisify(execFile);

const WINDOW_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][ValidateSet('focus', 'move')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [string]$Title,
  [int]$X,
  [int]$Y,
  [int]$Width,
  [int]$Height
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinUtilsWindowActions {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
}
'@

$name = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
$processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($Title) {
  $processes = @($processes | Where-Object { $_.MainWindowTitle.IndexOf($Title, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
$target = $processes | Select-Object -First 1
if (-not $target) {
  throw "No visible window was found for $ProcessName."
}

if ($Action -eq 'focus') {
  [void][WinUtilsWindowActions]::ShowWindowAsync($target.MainWindowHandle, 9)
  if (-not [WinUtilsWindowActions]::SetForegroundWindow($target.MainWindowHandle)) {
    throw "Windows refused to focus $ProcessName."
  }
  return
}

if ($Width -lt 1 -or $Height -lt 1) {
  throw 'Window width and height must be greater than zero.'
}
if (-not [WinUtilsWindowActions]::MoveWindow($target.MainWindowHandle, $X, $Y, $Width, $Height, $true)) {
  throw "Windows refused to move or resize $ProcessName."
}
`;

const CLOSE_WINDOW_SCRIPT = String.raw`
param([Parameter(Mandatory = $true)][string]$ProcessName)
$ErrorActionPreference = 'Stop'
$name = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
$processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($processes.Count -eq 0) {
  throw "No visible window was found for $ProcessName."
}
$closed = $false
foreach ($process in $processes) {
  if ($process.CloseMainWindow()) { $closed = $true }
}
if (-not $closed) {
  throw "$ProcessName did not accept a normal close request."
}
`;

const KILL_PROCESS_SCRIPT = String.raw`
param([Parameter(Mandatory = $true)][string]$ProcessName)
$ErrorActionPreference = 'Stop'
$name = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
$processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0) {
  throw "Process $ProcessName is not running."
}
$processes | Stop-Process -Force -ErrorAction Stop
`;

const WAIT_PROCESS_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [Parameter(Mandatory = $true)][int]$TimeoutSeconds
)
$ErrorActionPreference = 'Stop'
$name = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) { return }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw "Timed out waiting for $ProcessName after $TimeoutSeconds seconds."
`;

export function registerSystemActions(actions: ActionEngine): void {
  const registrations: AutomationActionRegistration[] = [
    {
      definition: {
        id: 'application.launch',
        ownerId: 'system-actions',
        ownerLabel: 'Applications',
        label: 'Launch application',
        description: 'Start an executable with optional arguments',
        category: 'application',
        keywords: ['launch', 'start', 'open', 'exe', 'application'],
        parameters: [
          { id: 'path', label: 'Executable path', type: 'string', required: true, placeholder: 'C:\\Path\\App.exe' },
          { id: 'arguments', label: 'Arguments', type: 'string', placeholder: '--optional arguments' },
        ],
      },
      handler: async parameters => {
        const executable = stringParameter(parameters, 'path');
        if (!existsSync(executable)) throw new Error(`Application does not exist: ${executable}`);
        const child = spawn(executable, splitWindowsArguments(optionalStringParameter(parameters, 'arguments')), {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        child.unref();
      },
    },
    {
      definition: {
        id: 'application.close',
        ownerId: 'system-actions',
        ownerLabel: 'Applications',
        label: 'Close application',
        description: 'Ask every visible window for an application to close normally',
        category: 'application',
        keywords: ['close', 'exit', 'application', 'process'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
        ],
      },
      handler: parameters => runPowerShell(CLOSE_WINDOW_SCRIPT, [exactProcessNameParameter(parameters, 'processName')]),
    },
    {
      definition: {
        id: 'process.kill',
        ownerId: 'system-actions',
        ownerLabel: 'Processes',
        label: 'Kill process',
        description: 'Forcefully stop every process with an exact process name',
        category: 'application',
        keywords: ['kill', 'force', 'stop', 'task', 'process'],
        dangerous: true,
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'notepad.exe' },
        ],
      },
      handler: parameters => runPowerShell(KILL_PROCESS_SCRIPT, [exactProcessNameParameter(parameters, 'processName')]),
    },
    {
      definition: {
        id: 'application.wait',
        ownerId: 'system-actions',
        ownerLabel: 'Applications',
        label: 'Wait for application',
        description: 'Pause until an application starts or the timeout expires',
        category: 'application',
        keywords: ['wait', 'process', 'application', 'start', 'timeout'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
          { id: 'timeoutSeconds', label: 'Timeout (seconds)', type: 'number', required: true, defaultValue: 30, min: 1, max: 3600 },
        ],
      },
      handler: parameters => runPowerShell(WAIT_PROCESS_SCRIPT, [
        exactProcessNameParameter(parameters, 'processName'),
        String(numberParameter(parameters, 'timeoutSeconds')),
      ], (numberParameter(parameters, 'timeoutSeconds') + 5) * 1000),
    },
    {
      definition: {
        id: 'window.focus',
        ownerId: 'system-actions',
        ownerLabel: 'Windows',
        label: 'Focus window',
        description: 'Restore and focus the first matching application window',
        category: 'window',
        keywords: ['focus', 'activate', 'restore', 'window'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
          { id: 'title', label: 'Window title contains', type: 'string', placeholder: 'Optional title filter' },
        ],
      },
      handler: parameters => runWindowAction('focus', parameters),
    },
    {
      definition: {
        id: 'window.moveResize',
        ownerId: 'system-actions',
        ownerLabel: 'Windows',
        label: 'Move and resize window',
        description: 'Position a matching window using absolute desktop coordinates',
        category: 'window',
        keywords: ['move', 'resize', 'position', 'window', 'monitor'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
          { id: 'title', label: 'Window title contains', type: 'string', placeholder: 'Optional title filter' },
          { id: 'x', label: 'X', type: 'number', required: true, defaultValue: 0 },
          { id: 'y', label: 'Y', type: 'number', required: true, defaultValue: 0 },
          { id: 'width', label: 'Width', type: 'number', required: true, defaultValue: 960, min: 1 },
          { id: 'height', label: 'Height', type: 'number', required: true, defaultValue: 1080, min: 1 },
        ],
      },
      handler: parameters => runWindowAction('move', parameters),
    },
    {
      definition: {
        id: 'clipboard.setText',
        ownerId: 'system-actions',
        ownerLabel: 'Clipboard Manager',
        label: 'Set clipboard text',
        description: 'Replace the current Windows clipboard text',
        category: 'clipboard',
        keywords: ['clipboard', 'copy', 'set', 'text'],
        parameters: [
          { id: 'text', label: 'Text', type: 'string', required: true, multiline: true, placeholder: 'Text to place on the clipboard' },
        ],
      },
      handler: parameters => {
        clipboard.writeText(stringParameter(parameters, 'text'));
      },
    },
    {
      definition: {
        id: 'system.openPath',
        ownerId: 'system-actions',
        ownerLabel: 'Files',
        label: 'Open file or folder',
        description: 'Open a local file or folder with its Windows default handler',
        category: 'file',
        keywords: ['open', 'file', 'folder', 'explorer', 'path'],
        parameters: [
          { id: 'path', label: 'Path', type: 'string', required: true, placeholder: 'C:\\Path\\File.txt' },
        ],
      },
      handler: async parameters => {
        const target = stringParameter(parameters, 'path');
        if (!existsSync(target)) throw new Error(`Path does not exist: ${target}`);
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      },
    },
    {
      definition: {
        id: 'system.openUrl',
        ownerId: 'system-actions',
        ownerLabel: 'System',
        label: 'Open URL',
        description: 'Open an HTTP or HTTPS address in the default browser',
        category: 'system',
        keywords: ['open', 'url', 'website', 'browser', 'link'],
        parameters: [
          { id: 'url', label: 'URL', type: 'string', required: true, placeholder: 'https://example.com' },
        ],
      },
      handler: async parameters => {
        const url = new URL(stringParameter(parameters, 'url'));
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          throw new Error('Only HTTP and HTTPS URLs are supported.');
        }

        await shell.openExternal(url.toString());
      },
    },
    {
      definition: {
        id: 'system.notification',
        ownerId: 'system-actions',
        ownerLabel: 'System',
        label: 'Show notification',
        description: 'Display a native Windows notification',
        category: 'system',
        keywords: ['show', 'notification', 'toast', 'message', 'alert'],
        parameters: [
          { id: 'title', label: 'Title', type: 'string', required: true, defaultValue: 'WinUtils' },
          { id: 'message', label: 'Message', type: 'string', required: true, multiline: true },
        ],
      },
      handler: parameters => {
        if (!Notification.isSupported()) throw new Error('Windows notifications are not available.');
        new Notification({
          title: stringParameter(parameters, 'title'),
          body: stringParameter(parameters, 'message'),
        }).show();
      },
    },
    {
      definition: {
        id: 'system.runPowerShell',
        ownerId: 'system-actions',
        ownerLabel: 'System',
        label: 'Run PowerShell',
        description: 'Run a PowerShell command and wait for it to finish',
        category: 'system',
        keywords: ['run', 'powershell', 'command', 'script'],
        dangerous: true,
        parameters: [
          { id: 'command', label: 'Command', type: 'string', required: true, multiline: true },
          { id: 'workingDirectory', label: 'Working directory', type: 'string', placeholder: 'Optional folder' },
        ],
      },
      handler: parameters => execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', stringParameter(parameters, 'command'),
      ], {
        cwd: optionalStringParameter(parameters, 'workingDirectory') || undefined,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
    signal: automationSignal(),
      }).then(() => undefined),
    },
  ];

  actions.replaceOwnerActions('system-actions', registrations);
}

export function registerAudioActions(actions: ActionEngine, audioManager: FocusAudioManager): void {
  actions.replaceOwnerActions('audio-actions', [
    {
      definition: {
        id: 'audio.setApplicationVolume',
        ownerId: 'audio-actions',
        ownerLabel: 'Audio',
        label: 'Set application volume',
        description: 'Set the volume of every active audio session for an application',
        category: 'audio',
        keywords: ['audio', 'application', 'session', 'volume', 'sound'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Spotify.exe' },
          { id: 'volume', label: 'Volume percent', type: 'number', required: true, defaultValue: 50, min: 0, max: 100 },
        ],
      },
      handler: parameters => audioManager.setApplicationVolume(
        exactProcessNameParameter(parameters, 'processName'),
        numberParameter(parameters, 'volume'),
      ),
    },
    {
      definition: {
        id: 'audio.setApplicationMuted',
        ownerId: 'audio-actions',
        ownerLabel: 'Audio',
        label: 'Mute or unmute application',
        description: 'Change the mute state of every active audio session for an application',
        category: 'audio',
        keywords: ['audio', 'application', 'session', 'mute', 'unmute'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
          { id: 'muted', label: 'Muted', type: 'boolean', required: true, defaultValue: true },
        ],
      },
      handler: parameters => audioManager.setApplicationMuted(
        exactProcessNameParameter(parameters, 'processName'),
        booleanParameter(parameters, 'muted'),
      ),
    },
  ]);
}

async function runWindowAction(action: 'focus' | 'move', parameters: Record<string, unknown>): Promise<void> {
  await runPowerShell(WINDOW_SCRIPT, [
    action,
    exactProcessNameParameter(parameters, 'processName'),
    optionalStringParameter(parameters, 'title'),
    String(optionalNumberParameter(parameters, 'x', 0)),
    String(optionalNumberParameter(parameters, 'y', 0)),
    String(optionalNumberParameter(parameters, 'width', 960)),
    String(optionalNumberParameter(parameters, 'height', 1080)),
  ]);
}

async function runPowerShell(script: string, args: string[], timeout = 60_000): Promise<void> {
  const invocation = `$winUtilsArgs = @(for ($i = 0; $i -lt [int]$env:WINUTILS_ACTION_ARG_COUNT; $i++) { [Environment]::GetEnvironmentVariable("WINUTILS_ACTION_ARG_$i") }); & {\n${script}\n} @winUtilsArgs`;
  const argumentEnvironment = Object.fromEntries(
    args.map((value, index) => [`WINUTILS_ACTION_ARG_${index}`, value]),
  );
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', invocation,
  ], {
    timeout,
    windowsHide: true,
    signal: automationSignal(),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      WINUTILS_ACTION_ARG_COUNT: String(args.length),
      ...argumentEnvironment,
    },
  });
}

function stringParameter(parameters: Record<string, unknown>, id: string): string {
  const value = parameters[id];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${id} is required.`);
  return value.trim();
}

function exactProcessNameParameter(parameters: Record<string, unknown>, id: string): string {
  const value = stringParameter(parameters, id);
  if (/[*?\[\]]/.test(value)) {
    throw new Error('Process names cannot contain wildcard characters.');
  }
  return value;
}

function optionalStringParameter(parameters: Record<string, unknown>, id: string): string {
  const value = parameters[id];
  return typeof value === 'string' ? value.trim() : '';
}

function booleanParameter(parameters: Record<string, unknown>, id: string): boolean {
  const value = parameters[id];
  if (typeof value !== 'boolean') throw new Error(`${id} must be true or false.`);
  return value;
}

function numberParameter(parameters: Record<string, unknown>, id: string): number {
  const value = parameters[id];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${id} must be a number.`);
  return value;
}

function optionalNumberParameter(parameters: Record<string, unknown>, id: string, fallback: number): number {
  const value = parameters[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

