import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  Macro,
  MacroAction,
  MacroConfig,
  MacroFolder,
  MacroProfile,
  MacroState,
} from '../shared/macro';
import { executeMacro } from './macroExecutor';
import { clearHotkeys, registerHotkey, startHook, stopHook } from './macroHook';
import { MacroStore } from './macroStore';

export class MacroManager {
  private readonly store = new MacroStore();
  private initialized = false;
  private logPath = path.join(tmpdir(), 'winutils-focus-debug.log');

  private log(msg: string): void {
    appendFileSync(this.logPath, `[${new Date().toISOString()}] ${msg}\n`);
  }

  // ─── Focus monitor ────────────────────────────────────────────────────
  private focusWorker: ChildProcess | null = null;
  private focusPollInterval: NodeJS.Timeout | null = null;
  /** Process name of this executable (no .exe), used to skip self-focus. */
  private readonly ownProcessName = path.basename(process.execPath, '.exe').toLowerCase();
  /** Weak/unstable process tokens that should never be used for binding identity. */
  private readonly weakProcessTokens = new Set(['idle', 'system']);
  /** The profile the user manually selected — auto-switch reverts to this. */
  private manualProfile = '';
  /** Last known normalized process token for a PID (helps with anti-cheat drops). */
  private readonly pidTokenCache = new Map<number, { token: string; seenAt: number }>();
  /** Ignore stale PID-token associations to avoid long-lived misidentification. */
  private readonly pidTokenCacheTtlMs = 3 * 60 * 1000;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    writeFileSync(this.logPath, '=== MacroManager init ===\n', 'utf8');
    this.log('Starting');
    await this.store.load();
    const cfg = this.store['_config'] as MacroConfig;
    this.manualProfile = cfg.activeProfile;

    // One-time sanitization for existing profiles in case unstable bindings
    // like "Idle" were previously added and can poison switching.
    let changed = false;
    for (const profile of cfg.profiles) {
      const cleaned = this.sanitizeBindings(profile.processBindings ?? []);
      const current = profile.processBindings ?? [];
      if (cleaned.length !== current.length || cleaned.some((v, i) => v !== current[i])) {
        profile.processBindings = cleaned;
        changed = true;
      }
    }
    if (changed) {
      await this.store.save();
    }

    await startHook();
    this.rebuildHotkeys();
    this.startFocusMonitor();
  }

  // ─── Focus monitor implementation ─────────────────────────────────────

  private startFocusMonitor(): void {
    // Write the helper script to a temp file once so Add-Type compiles only
    // once at worker startup — not on every poll tick.
    const scriptPath = path.join(tmpdir(), 'winutils-focus-monitor.ps1');
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class FocusHelper {
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

  private static string GetProcessNameByPid(uint processId) {
    // Fast path used by ScriptFlow.
    try {
      using (var process = Process.GetProcessById((int)processId)) {
        if (!string.IsNullOrWhiteSpace(process.ProcessName)) {
          return process.ProcessName;
        }
      }
    } catch {
      // Fall back to limited-information query for protected processes.
    }

    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (handle == IntPtr.Zero) return null;
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(handle, 0, sb, ref size) || size <= 0) {
        return null;
      }

      var fullPath = sb.ToString(0, size);
      var fileName = Path.GetFileNameWithoutExtension(fullPath);
      return string.IsNullOrWhiteSpace(fileName) ? null : fileName;
    } finally {
      CloseHandle(handle);
    }
  }

  private static string GetProcessPathByPid(uint processId) {
    try {
      using (var process = Process.GetProcessById((int)processId)) {
        var mainModule = process.MainModule;
        if (mainModule != null && !string.IsNullOrWhiteSpace(mainModule.FileName)) {
          return mainModule.FileName;
        }
      }
    } catch {
      // Fall back to limited-information query for protected processes.
    }

    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
    if (handle == IntPtr.Zero) return null;
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (!QueryFullProcessImageName(handle, 0, sb, ref size) || size <= 0) {
        return null;
      }
      return sb.ToString(0, size);
    } finally {
      CloseHandle(handle);
    }
  }

  private static string GetWindowTitle(IntPtr hwnd) {
    try {
      int len = GetWindowTextLength(hwnd);
      if (len <= 0) return null;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hwnd, sb, sb.Capacity);
      var title = sb.ToString();
      return string.IsNullOrWhiteSpace(title) ? null : title;
    } catch {
      return null;
    }
  }

    public static string GetForegroundProcessSample() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;

        var title = GetWindowTitle(hwnd) ?? string.Empty;

        uint processId = 0;
        GetWindowThreadProcessId(hwnd, out processId);

        // Some fullscreen/protected games briefly report no foreground PID
        // during focus transitions, but still expose a useful window title.
        // Emit a title-only sample instead of dropping it so the TS-side title
        // fallback can recover game profiles such as HELLDIVERS 2.
        if (processId == 0) {
          if (string.IsNullOrWhiteSpace(title)) return null;
          return "0\t\t\t" + title;
        }

        var name = GetProcessNameByPid(processId) ?? string.Empty;
        var fullPath = GetProcessPathByPid(processId) ?? string.Empty;
        if (string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(fullPath)) {
          name = Path.GetFileNameWithoutExtension(fullPath);
        }

        // TSV payload: pid\tname\tpath\ttitle
        return processId.ToString() + "\t" + name + "\t" + fullPath + "\t" + title;
    }
}
'@ -Language CSharp

while ($true) {
    Start-Sleep -Milliseconds 500
    try {
        $sample = [FocusHelper]::GetForegroundProcessSample()
        if ($sample) {
          [Console]::Out.WriteLine($sample)
            [Console]::Out.Flush()
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
`.trimStart();

    writeFileSync(scriptPath, script, 'utf8');

    this.focusWorker = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = '';
    this.focusWorker.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const sample = line.trim();
        if (!sample) continue;
        const [pidRaw, nameRaw, pathRaw, titleRaw] = sample.split('\t');
        const pid = Number.parseInt(pidRaw ?? '', 10);
        const processName = (nameRaw ?? '').trim();
        const processPath = (pathRaw ?? '').trim();
        const windowTitle = (titleRaw ?? '').trim();
        this.onFocusChange(processName, Number.isFinite(pid) ? pid : null, processPath || null, windowTitle || null);
      }
    });

    this.focusWorker.stderr?.on('data', (chunk: Buffer) => {
      this.log(`Focus worker stderr: ${chunk.toString().trim()}`);
    });

    this.focusWorker.on('exit', (code) => {
      this.log(`Focus worker exited with code: ${code ?? 'null'}`);
      // Restart on unexpected exit (not during shutdown)
      if (this.focusWorker !== null) {
        this.focusWorker = null;
        setTimeout(() => { if (this.focusPollInterval !== null) this.startFocusMonitor(); }, 2000);
      }
    });

    // Sentinel to detect the monitor is alive
    this.focusPollInterval = setInterval(() => { /* keep-alive */ }, 60000);
  }

  private stopFocusMonitor(): void {
    if (this.focusPollInterval !== null) {
      clearInterval(this.focusPollInterval);
      this.focusPollInterval = null;
    }
    if (this.focusWorker) {
      this.focusWorker.kill();
      this.focusWorker = null;
    }
  }

  private normalizeCoreToken(value: string | null | undefined): string {
    return (value ?? '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2122\u00ae\u00a9]/g, ' ')
      .replace(/\b(?:tm|trademark|registered|copyright|r|c)\b/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  private normalizeProcessToken(value: string | null | undefined): string {
    return this.normalizeCoreToken((value ?? '').trim().replace(/\.exe$/i, ''));
  }

  private normalizeTitleToken(value: string | null | undefined): string {
    return this.normalizeCoreToken(value);
  }

  private normalizeLettersToken(value: string | null | undefined): string {
    return this.normalizeTitleToken(value).replace(/[0-9]/g, '');
  }

  private isWeakToken(token: string | null | undefined): boolean {
    const t = token ?? '';
    return !t || this.weakProcessTokens.has(t);
  }

  private sanitizeBindings(bindings: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of bindings) {
      const cleaned = this.normalizeProcessToken(raw);
      if (this.isWeakToken(cleaned)) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
    return out;
  }

  private readFreshPidToken(pid: number, now: number): string | null {
    const entry = this.pidTokenCache.get(pid);
    if (!entry) return null;
    if (now - entry.seenAt > this.pidTokenCacheTtlMs) {
      this.pidTokenCache.delete(pid);
      return null;
    }
    return entry.token;
  }

  private prunePidTokenCache(now: number): void {
    for (const [pid, entry] of this.pidTokenCache.entries()) {
      if (now - entry.seenAt > this.pidTokenCacheTtlMs) {
        this.pidTokenCache.delete(pid);
      }
    }
  }

  private findProfileByProcessIdentity(
    cfg: MacroConfig,
    effectiveToken: string,
    nameLower: string,
    pathBaseLower: string,
    pathLower: string,
  ): MacroProfile | undefined {
    return cfg.profiles.find(p => p.processBindings?.some(b => {
      const bLower = this.normalizeProcessToken(b);
      if (this.isWeakToken(bLower)) return false;
      if (this.tokenMatches(bLower, effectiveToken)) return true;
      if (this.tokenMatches(bLower, nameLower)) return true;
      if (this.tokenMatches(bLower, pathBaseLower)) return true;
      // Optional support for path fragments in bindings.
      return pathLower.includes(bLower);
    }));
  }

  private findProfileByWindowTitle(cfg: MacroConfig, titleToken: string): MacroProfile | undefined {
    if (!titleToken) return undefined;
    return cfg.profiles.find(p => p.processBindings?.some(b => {
      const bTitle = this.normalizeTitleToken(b);
      return !!bTitle && this.tokenMatches(bTitle, titleToken);
    }));
  }

  private tokenMatches(binding: string, candidate: string): boolean {
    if (!binding || !candidate) return false;
    if (binding === candidate) return true;

    // Allow containment matches for longer tokens.
    if (binding.length >= 5 && candidate.includes(binding)) return true;
    if (candidate.length >= 5 && binding.includes(candidate)) return true;

    // Anti-cheat/game title fallback: compare letter-only tokens.
    const bLetters = this.normalizeLettersToken(binding);
    const cLetters = this.normalizeLettersToken(candidate);
    if (!bLetters || !cLetters) return false;
    if (bLetters === cLetters) return true;
    if (bLetters.length >= 6 && cLetters.includes(bLetters)) return true;
    if (cLetters.length >= 6 && bLetters.includes(cLetters)) return true;
    return false;
  }

  private onFocusChange(processName: string, processId: number | null, processPath: string | null, windowTitle: string | null): void {
    const cfg = this.store['_config'] as MacroConfig;
    const now = Date.now();
    this.prunePidTokenCache(now);

    const nameLower = this.normalizeProcessToken(processName);
    const pathLower = (processPath ?? '').trim().toLowerCase();
    const pathBaseLower = this.normalizeProcessToken(pathLower ? path.basename(pathLower) : '');
    const titleToken = this.normalizeTitleToken(windowTitle);
    const hasStrongNameOrPath = !this.isWeakToken(pathBaseLower) || !this.isWeakToken(nameLower);
    let effectiveToken = !this.isWeakToken(pathBaseLower)
      ? pathBaseLower
      : (!this.isWeakToken(nameLower) ? nameLower : '');

    // Cache and recover process identity by PID for protected games that may
    // intermittently hide metadata while focused.
    if (processId !== null) {
      if (!this.isWeakToken(effectiveToken)) {
        this.pidTokenCache.set(processId, { token: effectiveToken, seenAt: now });
      } else {
        const cached = this.readFreshPidToken(processId, now);
        if (cached && !this.isWeakToken(cached)) {
          effectiveToken = cached;
        }
      }
    }

    const hasStrongIdentity = !this.isWeakToken(effectiveToken) || hasStrongNameOrPath;

    const idText = processId === null ? 'n/a' : String(processId);

    this.log(`Process: "${processName}" pid=${idText} path="${processPath ?? ''}" title="${windowTitle ?? ''}" (normalized: "${nameLower}", effective: "${effectiveToken}", titleToken: "${titleToken}"), Current: "${cfg.activeProfile}", Manual: "${this.manualProfile}"`);

    const fallbackProfile = cfg.profiles.some(p => p.name === this.manualProfile)
      ? this.manualProfile
      : 'Default';

    // When our own window is focused, return to the manual/base profile.
    if (effectiveToken === this.ownProcessName || nameLower === this.ownProcessName || pathBaseLower === this.ownProcessName) {
      if (cfg.activeProfile !== fallbackProfile) {
        this.log(`  → WinUtils window, switching to fallback "${fallbackProfile}"`);
        cfg.activeProfile = fallbackProfile;
        this.rebuildHotkeys();
        this.pushStateToRenderer();
      } else {
        this.log(`  → WinUtils window, already on fallback "${fallbackProfile}"`);
      }
      return;
    }

    // Stage 1: reliable identity signals (exe/path/name), including fresh PID recovery.
    const identityMatch = this.findProfileByProcessIdentity(cfg, effectiveToken, nameLower, pathBaseLower, pathLower);
    // Stage 2: only if identity did not match, allow title-based fallback.
    const titleMatch = identityMatch ? undefined : this.findProfileByWindowTitle(cfg, titleToken);
    const match = identityMatch ?? titleMatch;

    this.log(`  → Profiles: ${cfg.profiles.map(p => `${p.name}(${JSON.stringify(p.processBindings)})`).join(', ')}`);
    this.log(`  → Match: ${match ? match.name : 'NONE'}`);

    // Avoid bricking on uncertain samples (e.g., transient "Idle" with no useful title).
    // If identity is weak and there is no explicit match, keep current profile until
    // a stronger sample arrives.
    if (!match && !hasStrongIdentity && !titleToken) {
      this.log('  → Weak/uncertain sample; keeping current profile');
      return;
    }

    const desiredProfile = match?.name ?? fallbackProfile;

    if (cfg.activeProfile !== desiredProfile) {
      this.log(`  → SWITCH to "${desiredProfile}"`);
      cfg.activeProfile = desiredProfile;
      this.rebuildHotkeys();
      this.pushStateToRenderer();
    } else {
      this.log(`  → Already on ${desiredProfile}, no switch`);
    }
  }

  private pushStateToRenderer(): void {
    const state = this.getState();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('macros:profileChanged', state);
      }
    }
  }

  private rebuildHotkeys(): void {
    clearHotkeys();
    const profile = this.store.getActiveProfile();
    const allMacros = [...profile.macros, ...profile.folders.flatMap(f => f.macros)];
    for (const macro of allMacros) {
      if (macro.enabled && macro.hotkey.trim()) {
        registerHotkey(macro.hotkey, () => {
          executeMacro(macro).catch(() => {});
        });
      }
    }
  }

  private getState(): MacroState {
    return this.store.buildState();
  }

  // ─── Mutations ──────────────────────────────────────────────────────────

  async upsertMacro(macro: Macro, profileName?: string): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    const profile = profileName
      ? cfg.profiles.find(p => p.name === profileName) ?? this.store.getActiveProfile()
      : this.store.getActiveProfile();

    const rootIdx = profile.macros.findIndex(m => m.id === macro.id);
    if (rootIdx >= 0) {
      profile.macros[rootIdx] = macro;
    } else {
      let found = false;
      for (const folder of profile.folders) {
        const fi = folder.macros.findIndex(m => m.id === macro.id);
        if (fi >= 0) { folder.macros[fi] = macro; found = true; break; }
      }
      if (!found) profile.macros.push(macro);
    }

    await this.store.save();
    this.rebuildHotkeys();
    return this.getState();
  }

  async deleteMacro(macroId: string): Promise<MacroState> {
    const profile = this.store.getActiveProfile();
    profile.macros = profile.macros.filter(m => m.id !== macroId);
    for (const folder of profile.folders) {
      folder.macros = folder.macros.filter(m => m.id !== macroId);
    }
    await this.store.save();
    this.rebuildHotkeys();
    return this.getState();
  }

  async moveMacroToFolder(macroId: string, folderId: string | null): Promise<MacroState> {
    const profile = this.store.getActiveProfile();

    // Extract macro from wherever it currently lives
    let macro: Macro | undefined;
    const rootIdx = profile.macros.findIndex(m => m.id === macroId);
    if (rootIdx >= 0) {
      [macro] = profile.macros.splice(rootIdx, 1);
    } else {
      for (const folder of profile.folders) {
        const fi = folder.macros.findIndex(m => m.id === macroId);
        if (fi >= 0) { [macro] = folder.macros.splice(fi, 1); break; }
      }
    }
    if (!macro) return this.getState();

    if (folderId === null) {
      profile.macros.push(macro);
    } else {
      const target = profile.folders.find(f => f.id === folderId);
      if (target) target.macros.push(macro);
    }

    await this.store.save();
    this.rebuildHotkeys();
    return this.getState();
  }

  async upsertFolder(folder: MacroFolder): Promise<MacroState> {
    const profile = this.store.getActiveProfile();
    const idx = profile.folders.findIndex(f => f.id === folder.id);
    if (idx >= 0) profile.folders[idx] = folder;
    else profile.folders.push(folder);
    await this.store.save();
    return this.getState();
  }

  async deleteFolder(folderId: string): Promise<MacroState> {
    const profile = this.store.getActiveProfile();
    const folder = profile.folders.find(f => f.id === folderId);
    if (folder) {
      // Move macros to root before deleting
      profile.macros.push(...folder.macros);
      profile.folders = profile.folders.filter(f => f.id !== folderId);
    }
    await this.store.save();
    return this.getState();
  }

  async switchProfile(name: string): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    if (cfg.profiles.some(p => p.name === name)) {
      cfg.activeProfile = name;
      // User made a manual selection — clear auto-switch state
      this.manualProfile = name;
      this.pidTokenCache.clear();
      await this.store.save();
      this.rebuildHotkeys();
    }
    return this.getState();
  }

  async addProfile(name: string): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    if (!cfg.profiles.some(p => p.name === name)) {
      const profile: MacroProfile = { name, folders: [], macros: [] };
      cfg.profiles.push(profile);
      await this.store.save();
    }
    return this.getState();
  }

  async deleteProfile(name: string): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    if (name === 'Default' || cfg.profiles.length <= 1) return this.getState();
    cfg.profiles = cfg.profiles.filter(p => p.name !== name);
    if (cfg.activeProfile === name) cfg.activeProfile = 'Default';
    await this.store.save();
    this.rebuildHotkeys();
    return this.getState();
  }

  async runMacro(macroId: string): Promise<void> {
    const profile = this.store.getActiveProfile();
    const all = [...profile.macros, ...profile.folders.flatMap(f => f.macros)];
    const macro = all.find(m => m.id === macroId);
    if (macro) await executeMacro(macro);
  }

  async reorderActions(macroId: string, actions: MacroAction[]): Promise<MacroState> {
    const profile = this.store.getActiveProfile();
    const all = [...profile.macros, ...profile.folders.flatMap(f => f.macros)];
    const macro = all.find(m => m.id === macroId);
    if (macro) macro.actions = actions;
    await this.store.save();
    return this.getState();
  }

  async updateRecordHotkey(hotkey: string): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    cfg.recordToggleHotkey = hotkey;
    await this.store.save();
    return this.getState();
  }

  async updateProcessBindings(profileName: string, bindings: string[]): Promise<MacroState> {
    const cfg = this.store['_config'] as MacroConfig;
    const profile = cfg.profiles.find(p => p.name === profileName);
    if (profile) {
      profile.processBindings = this.sanitizeBindings(bindings);
      await this.store.save();
    }
    return this.getState();
  }

  getActiveApps(): Promise<string[]> {
    return new Promise<string[]>(resolve => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique",
        ],
        { timeout: 5000 },
        (_err, stdout) => {
          resolve(
            stdout
              .split('\n')
              .map(l => this.normalizeProcessToken(l.trim()))
              .filter(token => !this.isWeakToken(token) && token !== this.ownProcessName)
              .filter((token, idx, arr) => arr.indexOf(token) === idx),
          );
        },
      );
    });
  }

  destroy(): void {
    this.stopFocusMonitor();
    stopHook();
  }
}

export function registerMacroIpcHandlers(manager: MacroManager): void {
  ipcMain.handle('macros:getState', async () => {
    await manager.init();
    return manager['getState']();
  });

  ipcMain.handle('macros:upsertMacro', async (_e, macro: Macro, profileName?: string) => {
    await manager.init();
    return manager.upsertMacro(macro, profileName);
  });

  ipcMain.handle('macros:deleteMacro', async (_e, macroId: string) => {
    return manager.deleteMacro(macroId);
  });

  ipcMain.handle('macros:runMacro', async (_e, macroId: string) => {
    return manager.runMacro(macroId);
  });

  ipcMain.handle('macros:reorderActions', async (_e, macroId: string, actions: MacroAction[]) => {
    return manager.reorderActions(macroId, actions);
  });

  ipcMain.handle('macros:moveMacroToFolder', async (_e, macroId: string, folderId: string | null) => {
    return manager.moveMacroToFolder(macroId, folderId);
  });

  ipcMain.handle('macros:upsertFolder', async (_e, folder: MacroFolder) => {
    return manager.upsertFolder(folder);
  });

  ipcMain.handle('macros:deleteFolder', async (_e, folderId: string) => {
    return manager.deleteFolder(folderId);
  });

  ipcMain.handle('macros:switchProfile', async (_e, name: string) => {
    return manager.switchProfile(name);
  });

  ipcMain.handle('macros:addProfile', async (_e, name: string) => {
    return manager.addProfile(name);
  });

  ipcMain.handle('macros:deleteProfile', async (_e, name: string) => {
    return manager.deleteProfile(name);
  });

  ipcMain.handle('macros:updateProcessBindings', async (_e, profileName: string, bindings: string[]) => {
    return manager.updateProcessBindings(profileName, bindings);
  });

  ipcMain.handle('macros:getActiveApps', async () => {
    return manager.getActiveApps();
  });

  ipcMain.handle('macros:updateRecordHotkey', async (_e, hotkey: string) => {
    return manager.updateRecordHotkey(hotkey);
  });

  ipcMain.handle('macros:newId', () => randomUUID());
}
