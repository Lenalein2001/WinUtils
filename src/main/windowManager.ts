import { automationSignal } from './actionContext';
import { TaskPool } from './taskPool';
import { writeJsonAtomicallySync } from './atomicFile';
import { app, screen } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ManagedDisplay,
  ManagedWindow,
  SaveWindowLayoutInput,
  SavedWindowLayout,
  SavedWindowPlacement,
  WindowCommand,
  WindowCommandResult,
  WindowLayoutApplyResult,
  WindowManagerState,
  WindowPlacementPreset,
} from '../shared/windowManager';
import type { ActionEngine } from './actionEngine';

const execFileAsync = promisify(execFile);

const ENUMERATE_WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinUtilsWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length, flags, showCmd;
    public POINT ptMinPosition, ptMaxPosition;
    public RECT rcNormalPosition;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int size;
    public RECT monitor;
    public RECT work;
    public uint flags;
  }
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLong")] public static extern IntPtr GetWindowLongPtr32(IntPtr hWnd, int index);
  public static IntPtr GetWindowLongPtr(IntPtr hWnd, int index) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index) : GetWindowLongPtr32(hWnd, index);
  }
}
'@

$items = [System.Collections.Generic.List[object]]::new()
$callback = [WinUtilsWindows+EnumWindowsProc] {
  param([IntPtr]$handle, [IntPtr]$param)
  if (-not [WinUtilsWindows]::IsWindowVisible($handle)) { return $true }
  $length = [WinUtilsWindows]::GetWindowTextLength($handle)
  if ($length -le 0) { return $true }
  $title = [Text.StringBuilder]::new($length + 1)
  [void][WinUtilsWindows]::GetWindowText($handle, $title, $title.Capacity)
  if ([string]::IsNullOrWhiteSpace($title.ToString())) { return $true }

  [uint32]$processId = 0
  [void][WinUtilsWindows]::GetWindowThreadProcessId($handle, [ref]$processId)
  try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
  $rect = [WinUtilsWindows+RECT]::new()
  if (-not [WinUtilsWindows]::GetWindowRect($handle, [ref]$rect)) { return $true }
  $extendedStyle = [WinUtilsWindows]::GetWindowLongPtr($handle, -20).ToInt64()
  $state = if ([WinUtilsWindows]::IsIconic($handle)) { 'minimized' } elseif ([WinUtilsWindows]::IsZoomed($handle)) { 'maximized' } else { 'normal' }
  if ($state -ne 'normal') {
    $placement = [WinUtilsWindows+WINDOWPLACEMENT]::new()
    $placement.length = [Runtime.InteropServices.Marshal]::SizeOf([type][WinUtilsWindows+WINDOWPLACEMENT])
    if ([WinUtilsWindows]::GetWindowPlacement($handle, [ref]$placement)) {
      $rect = $placement.rcNormalPosition
      $monitor = [WinUtilsWindows]::MonitorFromWindow($handle, 2)
      $monitorInfo = [WinUtilsWindows+MONITORINFO]::new()
      $monitorInfo.size = [Runtime.InteropServices.Marshal]::SizeOf([type][WinUtilsWindows+MONITORINFO])
      if (($extendedStyle -band 0x80) -eq 0 -and $monitor -ne [IntPtr]::Zero -and [WinUtilsWindows]::GetMonitorInfo($monitor, [ref]$monitorInfo)) {
        $offsetX = $monitorInfo.work.Left - $monitorInfo.monitor.Left
        $offsetY = $monitorInfo.work.Top - $monitorInfo.monitor.Top
        $rect.Left += $offsetX
        $rect.Right += $offsetX
        $rect.Top += $offsetY
        $rect.Bottom += $offsetY
      }
    }
  }
  if (($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) { return $true }

  $processPath = $null
  try { $processPath = $process.Path } catch {}
  $items.Add([pscustomobject]@{
    id = $handle.ToInt64().ToString()
    processId = [int]$processId
    processName = $process.ProcessName
    processPath = $processPath
    title = $title.ToString()
    state = $state
    alwaysOnTop = (($extendedStyle -band 0x8) -ne 0)
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  })
  return $true
}
[void][WinUtilsWindows]::EnumWindows($callback, [IntPtr]::Zero)
@($items) | ConvertTo-Json -Compress -Depth 3
`;

const WINDOW_COMMAND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WindowHandle = [Int64]$env:WINUTILS_WINDOW_HANDLE
$Action = $env:WINUTILS_WINDOW_ACTION
$X = [int]$env:WINUTILS_WINDOW_X
$Y = [int]$env:WINUTILS_WINDOW_Y
$Width = [int]$env:WINUTILS_WINDOW_WIDTH
$Height = [int]$env:WINUTILS_WINDOW_HEIGHT
$Enabled = $env:WINUTILS_WINDOW_ENABLED -eq 'true'
$ExpectedProcessId = [uint32]$env:WINUTILS_WINDOW_PROCESS_ID
$IdentityProperty = $env:WINUTILS_WINDOW_IDENTITY
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinUtilsWindowCommand {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr hWnd, string name, IntPtr value);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr hWnd, string name);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
'@
$handle = [IntPtr]::new($WindowHandle)
if (-not [WinUtilsWindowCommand]::IsWindow($handle)) { throw 'The selected window no longer exists.' }
[uint32]$actualProcessId = 0
[void][WinUtilsWindowCommand]::GetWindowThreadProcessId($handle, [ref]$actualProcessId)
if ($ExpectedProcessId -ne 0 -and $actualProcessId -ne $ExpectedProcessId) {
  throw 'The selected window handle now belongs to a different application.'
}
if ($IdentityProperty -and $Action -ne 'hide' -and [WinUtilsWindowCommand]::GetProp($handle, $IdentityProperty) -eq [IntPtr]::Zero) {
  throw 'The selected hidden window no longer has the expected identity.'
}
switch ($Action) {
  'focus' {
    if ([WinUtilsWindowCommand]::IsIconic($handle)) {
      [void][WinUtilsWindowCommand]::ShowWindowAsync($handle, 9)
      for ($attempt = 0; $attempt -lt 20 -and [WinUtilsWindowCommand]::IsIconic($handle); $attempt++) {
        Start-Sleep -Milliseconds 25
      }
    } elseif (-not [WinUtilsWindowCommand]::IsWindowVisible($handle)) {
      [void][WinUtilsWindowCommand]::ShowWindowAsync($handle, 5)
      for ($attempt = 0; $attempt -lt 20 -and -not [WinUtilsWindowCommand]::IsWindowVisible($handle); $attempt++) {
        Start-Sleep -Milliseconds 25
      }
    }
    if (-not [WinUtilsWindowCommand]::SetForegroundWindow($handle)) { throw 'Windows refused to focus the selected window.' }
  }
  'minimize' { [void][WinUtilsWindowCommand]::ShowWindow($handle, 6) }
  'maximize' { [void][WinUtilsWindowCommand]::ShowWindow($handle, 3) }
  'restore' { [void][WinUtilsWindowCommand]::ShowWindow($handle, 9) }
  'hide' {
    if ($IdentityProperty -and -not [WinUtilsWindowCommand]::SetProp($handle, $IdentityProperty, [IntPtr]::new(1))) {
      throw 'Windows could not attach identity tracking to the selected window.'
    }
    [void][WinUtilsWindowCommand]::ShowWindowAsync($handle, 0)
    for ($attempt = 0; $attempt -lt 20 -and [WinUtilsWindowCommand]::IsWindowVisible($handle); $attempt++) {
      Start-Sleep -Milliseconds 25
    }
    if ([WinUtilsWindowCommand]::IsWindowVisible($handle)) { throw 'Windows did not hide the selected window.' }
  }
  'show' {
    [void][WinUtilsWindowCommand]::ShowWindowAsync($handle, 5)
    for ($attempt = 0; $attempt -lt 20 -and -not [WinUtilsWindowCommand]::IsWindowVisible($handle); $attempt++) {
      Start-Sleep -Milliseconds 25
    }
    if (-not [WinUtilsWindowCommand]::IsWindowVisible($handle)) { throw 'Windows did not show the selected window.' }
    if ($IdentityProperty) { [void][WinUtilsWindowCommand]::RemoveProp($handle, $IdentityProperty) }
  }
  'close' {
    if (-not [WinUtilsWindowCommand]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
      throw 'The selected window refused the close request.'
    }
  }
  'topmost' {
    $insertAfter = if ($Enabled) { [IntPtr]::new(-1) } else { [IntPtr]::new(-2) }
    if (-not [WinUtilsWindowCommand]::SetWindowPos($handle, $insertAfter, 0, 0, 0, 0, 0x0003)) {
      throw 'Windows refused to change the always-on-top state.'
    }
  }
  'move' {
    if ($Width -lt 1 -or $Height -lt 1) { throw 'Width and height must be greater than zero.' }
    [void][WinUtilsWindowCommand]::ShowWindow($handle, 9)
    for ($attempt = 0; $attempt -lt 20 -and [WinUtilsWindowCommand]::IsIconic($handle); $attempt++) {
      Start-Sleep -Milliseconds 25
    }
    if (-not [WinUtilsWindowCommand]::MoveWindow($handle, $X, $Y, $Width, $Height, $true)) {
      throw 'Windows refused to move or resize the selected window.'
    }
  }
}
`;

interface RawWindow {
  id: string;
  processId: number;
  processName: string;
  processPath: string | null;
  title: string;
  state: 'normal' | 'minimized' | 'maximized';
  alwaysOnTop: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HiddenWindowRecord extends ManagedWindow {
  identityProperty: string;
}

export class WindowManager {
  private readonly recoveryPath = path.join(app.getPath('userData'), 'hidden-window-recovery.json');
  private readonly layoutsPath = path.join(app.getPath('userData'), 'window-layouts.json');
  private layouts = this.readLayouts();
  private readonly hiddenWindows = new Map<string, HiddenWindowRecord>();
  private readonly pendingHides = new Map<string, number>();

  constructor(private readonly actions: ActionEngine) {
    if (fs.existsSync(this.recoveryPath)) {
      const records: unknown = JSON.parse(fs.readFileSync(this.recoveryPath, 'utf8'));
      if (!Array.isArray(records) || !records.every(isHiddenWindowRecord)) throw new Error('Invalid hidden-window recovery file; original preserved.');
      for (const record of records) this.hiddenWindows.set(record.id, record);
    }
    this.registerManagerActions();
    this.registerLayoutActions();
  }

  async getState(): Promise<WindowManagerState> {
    await this.pruneHiddenWindows();
    const [visibleWindows, displays] = await Promise.all([
      this.enumerateWindows(),
      Promise.resolve(this.getDisplays()),
    ]);
    const visibleIds = new Set(visibleWindows.map(window => window.id));
    let recoveryChanged = false;
    const now = Date.now();
    for (const id of visibleIds) {
      const pendingUntil = this.pendingHides.get(id);
      if (pendingUntil && pendingUntil > now) continue;
      this.pendingHides.delete(id);
      recoveryChanged = this.hiddenWindows.delete(id) || recoveryChanged;
    }
    for (const id of this.hiddenWindows.keys()) {
      if (!visibleIds.has(id)) this.pendingHides.delete(id);
    }
    if (recoveryChanged) this.persistRecovery();
    const windows = [
      ...visibleWindows,
      ...[...this.hiddenWindows.values()].filter(window => !visibleIds.has(window.id)),
    ];
    return {
      windows: windows
        .map(window => ({
          ...window,
          displayId: nearestDisplayId(window.bounds, displays),
        }))
        .sort((left, right) => (
          left.processName.localeCompare(right.processName)
          || left.title.localeCompare(right.title)
          || left.processId - right.processId
          || Number(left.id) - Number(right.id)
        )),
      displays,
      layouts: this.layouts,
      refreshedAt: new Date().toISOString(),
    };
  }

  async execute(command: WindowCommand): Promise<WindowCommandResult> {
    const target = (await this.getState()).windows.find(window => window.id === command.windowId);
    if (!target) {
      return {
        ok: false,
        error: 'The selected window is no longer available.',
        state: await this.getState(),
      };
    }
    const hiddenCandidate: HiddenWindowRecord | null = command.type === 'hide'
      ? {
          ...target,
          hidden: true,
          identityProperty: `WinUtils.Hidden.${process.pid}.${randomUUID()}`,
        }
      : this.hiddenWindows.get(command.windowId) ?? null;
    if (hiddenCandidate && command.type === 'hide') {
      this.hiddenWindows.set(command.windowId, hiddenCandidate);
      this.pendingHides.set(command.windowId, Date.now() + 30_000);
      this.persistRecovery();
    }
    try {
      await this.executeRaw(command, hiddenCandidate ?? target);
      await wait(command.type === 'close' ? 180 : 60);
      return { ok: true, state: await this.getState() };
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes('no longer exists')
        || error.message.includes('different application')
        || error.message.includes('expected identity')
        || error.message.includes('identity tracking')
      )) {
        this.hiddenWindows.delete(command.windowId);
        this.pendingHides.delete(command.windowId);
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: await this.getState(),
      };
    }
  }

  async saveLayout(input: SaveWindowLayoutInput): Promise<WindowManagerState> {
    const name = input.name.trim();
    if (!name) throw new Error('Enter a name for the window layout.');
    const windowIds = [...new Set(input.windowIds)];
    if (windowIds.length === 0) throw new Error('Select at least one window for the layout.');

    const state = await this.getState();
    const windows = new Map(state.windows.map(window => [window.id, window]));
    const displays = new Map(state.displays.map(display => [display.id, display]));
    const placements = windowIds.map(id => {
      const window = windows.get(id);
      if (!window) throw new Error('A selected window is no longer available. Refresh and try again.');
      return toSavedPlacement(window, window.displayId ? displays.get(window.displayId) : undefined);
    });
    const replacementIndex = this.layouts.findIndex(layout => layout.name.toLowerCase() === name.toLowerCase());
    const layout: SavedWindowLayout = {
      id: replacementIndex >= 0 ? this.layouts[replacementIndex].id : randomUUID(),
      name,
      createdAt: replacementIndex >= 0 ? this.layouts[replacementIndex].createdAt : new Date().toISOString(),
      placements,
    };
    this.layouts = replacementIndex >= 0
      ? this.layouts.map((item, index) => index === replacementIndex ? layout : item)
      : [...this.layouts, layout];
    this.persistLayouts();
    this.registerLayoutActions();
    return this.getState();
  }

  async deleteLayout(layoutId: string): Promise<WindowManagerState> {
    const next = this.layouts.filter(layout => layout.id !== layoutId);
    if (next.length === this.layouts.length) throw new Error('Window layout not found.');
    this.layouts = next;
    this.persistLayouts();
    this.registerLayoutActions();
    return this.getState();
  }

  async applyLayout(layoutId: string): Promise<WindowLayoutApplyResult> {
    const layout = this.layouts.find(item => item.id === layoutId);
    if (!layout) throw new Error('Window layout not found.');
    const state = await this.getState();
    const available = [...state.windows];
    const primaryDisplay = state.displays.find(display => display.primary) ?? state.displays[0];
    const unmatched: string[] = [];
    const errors: string[] = [];
    let applied = 0;

    for (const placement of layout.placements) {
      const matchIndex = findMatchingWindowIndex(available, placement);
      if (matchIndex < 0) {
        unmatched.push(`${placement.processName}: ${placement.title}`);
        continue;
      }
      const [window] = available.splice(matchIndex, 1);
      const display = state.displays.find(item => item.id === placement.displayId) ?? primaryDisplay;
      if (!display) {
        errors.push(`${placement.title}: no connected display is available.`);
        continue;
      }

      try {
        const bounds = fromRelativeBounds(placement.relativeBounds, display.workArea);
        await this.executeRaw({ type: 'move-resize', windowId: window.id, ...bounds }, window);
        if (placement.state === 'maximized') {
          await this.executeRaw({ type: 'maximize', windowId: window.id }, window);
        } else if (placement.state === 'minimized') {
          await this.executeRaw({ type: 'minimize', windowId: window.id }, window);
        }
        await this.executeRaw({
          type: 'set-always-on-top',
          windowId: window.id,
          enabled: placement.alwaysOnTop,
        }, window);
        applied += 1;
      } catch (error) {
        errors.push(`${placement.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      ok: unmatched.length === 0 && errors.length === 0,
      applied,
      unmatched,
      errors,
      state: await this.getState(),
    };
  }

  async restoreAll(): Promise<void> {
    const pool = new TaskPool(4);
    const results = await Promise.allSettled([...this.hiddenWindows.values()].map(window => pool.run(async () => {
      try { await this.executeRaw({ type: 'show', windowId: window.id }, window); }
      catch (error) {
        if (isIdentityError(error)) { this.hiddenWindows.delete(window.id); this.persistRecovery(); return; }
        throw error;
      }
    })));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new Error('Hidden-window restoration incomplete; recovery records retained: ' + failures.map(result => String(result.reason)).join('; '));
  }

  async dispose(): Promise<void> { await this.restoreAll(); }
  private persistRecovery(): void { writeJsonAtomicallySync(this.recoveryPath, [...this.hiddenWindows.values()]); }

  private async executeRaw(command: WindowCommand, expectedWindow: ManagedWindow): Promise<void> {
    const commandEnvironment = getCommandEnvironment(command, this.getDisplays(), expectedWindow);
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', WINDOW_COMMAND_SCRIPT,
    ], {
      timeout: 15_000,
      signal: command.type === 'show' ? undefined : automationSignal(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...commandEnvironment,
      },
    });
    if (command.type === 'show' || command.type === 'focus'
      || command.type === 'restore' || command.type === 'maximize' || command.type === 'minimize'
      || command.type === 'move-resize' || command.type === 'apply-preset') {
      this.hiddenWindows.delete(command.windowId);
      this.pendingHides.delete(command.windowId);
      this.persistRecovery();
    } else if (command.type === 'set-always-on-top') {
      const hidden = this.hiddenWindows.get(command.windowId);
      if (hidden) hidden.alwaysOnTop = command.enabled;
    }
  }

  private async pruneHiddenWindows(): Promise<void> {
    for (const window of [...this.hiddenWindows.values()]) {
      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command', WINDOW_COMMAND_SCRIPT,
        ], {
          timeout: 5_000,
          windowsHide: true,
          env: {
            ...process.env,
            ...getCommandEnvironment({ type: 'show', windowId: window.id }, this.getDisplays(), window),
            WINUTILS_WINDOW_ACTION: 'validate',
          },
        });
      } catch (error) {
        if (isIdentityError(error)) { this.hiddenWindows.delete(window.id); this.persistRecovery(); }
        else console.error('[WindowManager] Hidden-window verification failed.', error);
      }
    }
  }

  private async enumerateWindows(): Promise<Array<Omit<ManagedWindow, 'displayId'>>> {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', ENUMERATE_WINDOWS_SCRIPT,
    ], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = stdout.trim() ? JSON.parse(stdout) as RawWindow | RawWindow[] : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).map(window => ({
      id: String(window.id),
      processId: Number(window.processId),
      processName: String(window.processName),
      processPath: typeof window.processPath === 'string' ? window.processPath : null,
      title: String(window.title),
      state: window.state,
      hidden: false,
      alwaysOnTop: Boolean(window.alwaysOnTop),
      bounds: {
        x: Number(window.x),
        y: Number(window.y),
        width: Number(window.width),
        height: Number(window.height),
      },
    }));
  }

  private getDisplays(): ManagedDisplay[] {
    const primaryId = String(screen.getPrimaryDisplay().id);
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: display.label || `Monitor ${index + 1}`,
      primary: String(display.id) === primaryId,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      workArea: display.workArea,
    }));
  }

  private readLayouts(): SavedWindowLayout[] {
    if (!fs.existsSync(this.layoutsPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.layoutsPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('The saved layout file is not an array.');
      return parsed.filter(isSavedWindowLayout);
    } catch (error) {
      throw new Error(`Could not read window layouts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistLayouts(): void {
    writeJsonAtomicallySync(this.layoutsPath, this.layouts);
  }

  private registerLayoutActions(): void {
    this.actions.replaceOwnerActions('window-layouts', this.layouts.map(layout => ({
      definition: {
        id: `window.layout.${layout.id}`,
        ownerId: 'window-layouts',
        ownerLabel: 'Window Layouts',
        label: `Apply ${layout.name}`,
        description: `Restore ${layout.placements.length} saved window position${layout.placements.length === 1 ? '' : 's'}`,
        category: 'window',
        keywords: ['window', 'layout', 'desktop', 'monitor', layout.name.toLowerCase()],
      },
      handler: async () => {
        const result = await this.applyLayout(layout.id);
        if (!result.ok) {
          const details = [
            result.unmatched.length ? `Not open: ${result.unmatched.join(', ')}` : '',
            result.errors.length ? `Failed: ${result.errors.join(' ')}` : '',
          ].filter(Boolean).join(' ');
          throw new Error(details || 'Window layout could not be fully applied.');
        }
      },
    })));
  }

  private registerManagerActions(): void {
    this.actions.replaceOwnerActions('window-manager', [{
      definition: {
        id: 'window.applyPreset',
        ownerId: 'window-manager',
        ownerLabel: 'Window Manager',
        label: 'Apply window preset',
        description: 'Move the first matching application window to a monitor preset',
        category: 'window',
        keywords: ['window', 'move', 'monitor', 'preset', 'layout'],
        parameters: [
          { id: 'processName', label: 'Process name', type: 'string', required: true, placeholder: 'Discord.exe' },
          { id: 'monitor', label: 'Monitor number', type: 'number', required: true, defaultValue: 1, min: 1 },
          {
            id: 'preset',
            label: 'Preset',
            type: 'select',
            required: true,
            defaultValue: 'left-half',
            options: [
              { value: 'left-half', label: 'Left half' },
              { value: 'right-half', label: 'Right half' },
              { value: 'top-left', label: 'Top left' },
              { value: 'top-right', label: 'Top right' },
              { value: 'bottom-left', label: 'Bottom left' },
              { value: 'bottom-right', label: 'Bottom right' },
              { value: 'center', label: 'Center' },
              { value: 'fullscreen', label: 'Work area' },
            ],
          },
        ],
      },
      handler: async parameters => {
        const processName = String(parameters.processName ?? '').replace(/\.exe$/i, '').toLowerCase();
        const monitor = Math.trunc(Number(parameters.monitor));
        const preset = String(parameters.preset) as WindowPlacementPreset;
        const state = await this.getState();
        const window = state.windows.find(item => item.processName.toLowerCase() === processName);
        if (!window) throw new Error(`No visible window was found for ${processName}.exe.`);
        const display = state.displays[monitor - 1];
        if (!display) throw new Error(`Monitor ${monitor} is not connected.`);
        const result = await this.execute({ type: 'apply-preset', windowId: window.id, displayId: display.id, preset });
        if (!result.ok) throw new Error(result.error ?? 'Window preset failed.');
      },
    }]);
  }
}

function getCommandEnvironment(
  command: WindowCommand,
  displays: ManagedDisplay[],
  expectedWindow: ManagedWindow | HiddenWindowRecord,
): Record<string, string> {
  const base = {
    WINUTILS_WINDOW_HANDLE: command.windowId,
    WINUTILS_WINDOW_ACTION: command.type,
    WINUTILS_WINDOW_X: '0',
    WINUTILS_WINDOW_Y: '0',
    WINUTILS_WINDOW_WIDTH: '0',
    WINUTILS_WINDOW_HEIGHT: '0',
    WINUTILS_WINDOW_ENABLED: 'false',
    WINUTILS_WINDOW_PROCESS_ID: String(expectedWindow.processId),
    WINUTILS_WINDOW_IDENTITY: 'identityProperty' in expectedWindow ? expectedWindow.identityProperty : '',
  };
  if (command.type === 'set-always-on-top') {
    return {
      ...base,
      WINUTILS_WINDOW_ACTION: 'topmost',
      WINUTILS_WINDOW_ENABLED: String(command.enabled),
    };
  }
  if (command.type === 'move-resize') {
    return {
      ...base,
      WINUTILS_WINDOW_ACTION: 'move',
      WINUTILS_WINDOW_X: String(Math.round(command.x)),
      WINUTILS_WINDOW_Y: String(Math.round(command.y)),
      WINUTILS_WINDOW_WIDTH: String(Math.round(command.width)),
      WINUTILS_WINDOW_HEIGHT: String(Math.round(command.height)),
    };
  }
  if (command.type === 'apply-preset') {
    const display = displays.find(item => item.id === command.displayId);
    if (!display) throw new Error('The selected display is no longer connected.');
    const bounds = presetBounds(display.workArea, command.preset);
    return {
      ...base,
      WINUTILS_WINDOW_ACTION: 'move',
      WINUTILS_WINDOW_X: String(bounds.x),
      WINUTILS_WINDOW_Y: String(bounds.y),
      WINUTILS_WINDOW_WIDTH: String(bounds.width),
      WINUTILS_WINDOW_HEIGHT: String(bounds.height),
    };
  }
  return base;
}

function presetBounds(
  area: ManagedDisplay['workArea'],
  preset: WindowPlacementPreset,
): ManagedDisplay['workArea'] {
  const halfWidth = Math.floor(area.width / 2);
  const halfHeight = Math.floor(area.height / 2);
  if (preset === 'left-half') return { x: area.x, y: area.y, width: halfWidth, height: area.height };
  if (preset === 'right-half') return { x: area.x + halfWidth, y: area.y, width: area.width - halfWidth, height: area.height };
  if (preset === 'top-left') return { x: area.x, y: area.y, width: halfWidth, height: halfHeight };
  if (preset === 'top-right') return { x: area.x + halfWidth, y: area.y, width: area.width - halfWidth, height: halfHeight };
  if (preset === 'bottom-left') return { x: area.x, y: area.y + halfHeight, width: halfWidth, height: area.height - halfHeight };
  if (preset === 'bottom-right') return { x: area.x + halfWidth, y: area.y + halfHeight, width: area.width - halfWidth, height: area.height - halfHeight };
  if (preset === 'fullscreen') return { ...area };
  const width = Math.max(640, Math.round(area.width * 0.7));
  const height = Math.max(480, Math.round(area.height * 0.7));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

function nearestDisplayId(bounds: ManagedWindow['bounds'], displays: ManagedDisplay[]): string | null {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  let nearest: { id: string; distance: number } | null = null;
  for (const display of displays) {
    const area = display.bounds;
    const x = Math.max(area.x, Math.min(center.x, area.x + area.width));
    const y = Math.max(area.y, Math.min(center.y, area.y + area.height));
    const distance = (center.x - x) ** 2 + (center.y - y) ** 2;
    if (!nearest || distance < nearest.distance) nearest = { id: display.id, distance };
  }
  return nearest?.id ?? null;
}

function toSavedPlacement(window: ManagedWindow, display: ManagedDisplay | undefined): SavedWindowPlacement {
  const area = display?.workArea ?? window.bounds;
  return {
    processName: window.processName,
    title: window.title,
    displayId: window.displayId,
    relativeBounds: {
      x: area.width > 0 ? (window.bounds.x - area.x) / area.width : 0,
      y: area.height > 0 ? (window.bounds.y - area.y) / area.height : 0,
      width: area.width > 0 ? window.bounds.width / area.width : 1,
      height: area.height > 0 ? window.bounds.height / area.height : 1,
    },
    state: window.state,
    alwaysOnTop: window.alwaysOnTop,
  };
}

function fromRelativeBounds(
  relative: SavedWindowPlacement['relativeBounds'],
  area: ManagedDisplay['workArea'],
): ManagedWindow['bounds'] {
  return {
    x: Math.round(area.x + relative.x * area.width),
    y: Math.round(area.y + relative.y * area.height),
    width: Math.max(120, Math.round(relative.width * area.width)),
    height: Math.max(80, Math.round(relative.height * area.height)),
  };
}

function findMatchingWindowIndex(windows: ManagedWindow[], placement: SavedWindowPlacement): number {
  const processName = placement.processName.toLowerCase();
  const title = placement.title.toLowerCase();
  const exactMatches = windows
    .map((window, index) => ({ window, index }))
    .filter(item => (
      item.window.processName.toLowerCase() === processName
      && item.window.title.toLowerCase() === title
    ));
  if (exactMatches.length > 0) return exactMatches[0].index;
  const processMatches = windows
    .map((window, index) => ({ window, index }))
    .filter(item => item.window.processName.toLowerCase() === processName);
  return processMatches.length === 1 ? processMatches[0].index : -1;
}

function isSavedWindowLayout(value: unknown): value is SavedWindowLayout {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SavedWindowLayout>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.createdAt === 'string'
    && Array.isArray(candidate.placements);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isIdentityError(error: unknown): boolean {
  return /no longer exists|different application|expected identity/.test(String(error));
}
function isHiddenWindowRecord(value: unknown): value is HiddenWindowRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as HiddenWindowRecord;
  return typeof record.id === 'string' && /^[0-9]{1,20}$/.test(record.id)
    && Number.isSafeInteger(record.processId) && record.processId > 0
    && typeof record.identityProperty === 'string' && /^WinUtils\.Hidden\.[0-9]+\.[a-z0-9-]+$/.test(record.identityProperty)
    && typeof record.title === 'string' && typeof record.processName === 'string'
    && typeof record.alwaysOnTop === 'boolean' && record.hidden === true
    && !!record.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(record.bounds[key as keyof typeof record.bounds]))
    && record.bounds.width > 0 && record.bounds.height > 0;
}
