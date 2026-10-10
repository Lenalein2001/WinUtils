import { writeJsonAtomicallySync } from './atomicFile';
import { isClipboardExcluded } from './clipboardPrivacy';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { stat as statFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app, BrowserWindow, clipboard, powerMonitor, screen } from 'electron';
import type { ActionEngine } from './actionEngine';
import type {
  AutomationTrigger,
  AutomationTriggerInput,
  AutomationTriggerState,
  AutomationTriggerType,
} from '../shared/automationTriggers';

const WINDOWS_SNAPSHOT_WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinUtilsTriggerWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  public static string Read() {
    IntPtr handle = GetForegroundWindow();
    if (handle == IntPtr.Zero) return "";
    uint processId;
    GetWindowThreadProcessId(handle, out processId);
    int length = GetWindowTextLength(handle);
    var title = new StringBuilder(Math.Max(1, length + 1));
    GetWindowText(handle, title, title.Capacity);
    return processId + "|" + title.ToString();
  }
}
'@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  try {
    $processes = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique)
    $foregroundRaw = [WinUtilsTriggerWindow]::Read()
    $foreground = ''
    if ($foregroundRaw -match '^([0-9]+)\|(.*)$') {
      $focusedProcess = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
      if ($focusedProcess) { $foreground = $focusedProcess.ProcessName + '|' + $Matches[2] }
    }
    $payload = @{ processes = $processes; foreground = $foreground } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    [Console]::Out.WriteLine('SNAPSHOT ' + $encoded)
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('ERROR ' + $_.Exception.Message)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1000
}
`;

interface TriggerRuntime {
  running: boolean;
  queued: boolean;
  timer?: NodeJS.Timeout;
}

interface FileSnapshot {
  exists: boolean;
  modifiedMs: number;
  size: number;
}

export class AutomationTriggerManager {
  private readonly storePath = path.join(app.getPath('userData'), 'automation-triggers.json');
  private triggers: AutomationTrigger[] = [];
  private readonly runtimes = new Map<string, TriggerRuntime>();
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerBuffer = '';
  private workerReady = false;
  private workerRestartTimer: NodeJS.Timeout | null = null;
  private previousProcesses: Set<string> | null = null;
  private previousForeground = '';
  private lastSnapshotAt: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private clipboardTimer: NodeJS.Timeout | null = null;
  private previousClipboardSignature: string | null = null;
  private clipboardSequence: { sequence: number; capturedAt: number } | null = null;
  private previousDisplays = new Set<string>();
  private previousNetwork = new Set<string>();
  private networkMonitoring = false;
  private readonly fileSnapshots = new Map<string, FileSnapshot>();
  private initialized = false;
  private disposed = false;
  private tickRunning = false;
  private activeRuns = new Set<Promise<void>>();

  constructor(private readonly actions: ActionEngine,
    private readonly getClipboardSource?: () => { sequence: number; sampledAt: number } | null) {
    this.triggers = this.readStore();
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.previousDisplays = new Set(screen.getAllDisplays().map(display => String(display.id)));
    this.syncMonitoring();
    powerMonitor.on('unlock-screen', this.handleUnlock);
    screen.on('display-added', this.handleDisplayAdded);
    screen.on('display-removed', this.handleDisplayRemoved);
    setTimeout(() => void this.fireMatching('winutils-started'), 2500);
  }

  getState(): AutomationTriggerState {
    return {
      triggers: this.triggers.map(trigger => ({
        ...trigger,
        running: this.runtimeFor(trigger.id).running,
        queued: this.runtimeFor(trigger.id).queued,
      })),
      workerRunning: Boolean(this.worker && !this.worker.killed && this.workerReady),
      lastSnapshotAt: this.lastSnapshotAt,
    };
  }

  async upsert(input: AutomationTriggerInput): Promise<AutomationTriggerState> {
    const trigger = normalizeTrigger(input);
    const previous = structuredClone(this.triggers);
    const index = trigger.id ? this.triggers.findIndex(item => item.id === trigger.id) : -1;
    if (trigger.id && index < 0) throw new Error('Automation trigger not found.');
    if (index >= 0) {
      const existing = this.triggers[index];
      const resetFileSnapshot = fileTriggerIdentity(existing) !== fileTriggerIdentity(trigger)
        || (!existing.enabled && trigger.enabled);
      const runtime = this.runtimeFor(existing.id);
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.queued = false;
      Object.assign(existing, {
        ...existing,
        ...trigger,
        id: existing.id,
        lastRunAt: existing.lastRunAt,
        lastError: existing.lastError,
        runCount: existing.runCount,
      });
      if (resetFileSnapshot) this.fileSnapshots.delete(existing.id);
    } else {
      this.triggers.push({
        ...trigger,
        id: randomUUID(),
        lastRunAt: null,
        lastError: null,
        runCount: 0,
        running: false,
        queued: false,
      });
    }
    try { this.persist(); } catch (error) { this.triggers = previous; throw error; }
    this.syncMonitoring();
    this.notify();
    return this.getState();
  }

  async delete(id: string): Promise<AutomationTriggerState> {
    const next = this.triggers.filter(trigger => trigger.id !== id);
    if (next.length === this.triggers.length) throw new Error('Automation trigger not found.');
    const previous = this.triggers;
    this.triggers = next;
    try { this.persist(); } catch (error) { this.triggers = previous; throw error; }
    const runtime = this.runtimes.get(id);
    if (runtime?.timer) clearTimeout(runtime.timer);
    this.runtimes.delete(id);
    this.fileSnapshots.delete(id);
    this.syncMonitoring();
    this.notify();
    return this.getState();
  }

  async runNow(id: string): Promise<AutomationTriggerState> {
    const trigger = this.triggers.find(item => item.id === id);
    if (!trigger) throw new Error('Automation trigger not found.');
    await this.scheduleRun(trigger, true);
    return this.getState();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.initialized = false;
    if (this.workerRestartTimer) clearTimeout(this.workerRestartTimer);
    this.workerRestartTimer = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.clipboardTimer) clearInterval(this.clipboardTimer);
    this.tickTimer = null;
    this.clipboardTimer = null;
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.queued = false;
    }
    powerMonitor.removeListener('unlock-screen', this.handleUnlock);
    screen.removeListener('display-added', this.handleDisplayAdded);
    screen.removeListener('display-removed', this.handleDisplayRemoved);
    const worker = this.worker;
    this.worker = null;
    this.workerReady = false;
    if (worker && !worker.killed) worker.kill();
    await Promise.allSettled([...this.activeRuns]);
  }

  private readonly handleUnlock = (): void => {
    void this.fireMatching('windows-unlocked');
  };

  private readonly handleDisplayAdded = (_event: Electron.Event, display: Electron.Display): void => {
    const id = String(display.id);
    if (this.previousDisplays.has(id)) return;
    this.previousDisplays.add(id);
    void this.fireMatching('monitor-connected', display.label || id);
  };

  private readonly handleDisplayRemoved = (_event: Electron.Event, display: Electron.Display): void => {
    this.previousDisplays.delete(String(display.id));
  };

  private needsWindowWorker(): boolean {
    return this.triggers.some(trigger => trigger.enabled
      && ['application-started', 'application-closed', 'window-focused'].includes(trigger.type));
  }

  private syncMonitoring(): void {
    if (!this.initialized || this.disposed) return;
    if (this.needsWindowWorker()) {
      this.startWorker();
    } else {
      if (this.workerRestartTimer) clearTimeout(this.workerRestartTimer);
      this.workerRestartTimer = null;
      const worker = this.worker;
      this.worker = null;
      this.workerReady = false;
      this.workerBuffer = '';
      this.previousProcesses = null;
      this.previousForeground = '';
      this.lastSnapshotAt = null;
      if (worker && !worker.killed) worker.kill();
    }
    const needsNetwork = this.triggers.some(trigger => trigger.enabled && trigger.type === 'network-connected');
    if (needsNetwork && !this.networkMonitoring) this.previousNetwork = networkConnections();
    this.networkMonitoring = needsNetwork;
    const needsTick = this.triggers.some(trigger => trigger.enabled
      && ['schedule', 'file-created', 'file-modified', 'file-deleted', 'network-connected'].includes(trigger.type));
    if (needsTick && !this.tickTimer) {
      this.tickTimer = setInterval(() => void this.tick(), 1000);
    } else if (!needsTick && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const needsClipboard = this.triggers.some(trigger => trigger.enabled && trigger.type === 'clipboard-changed');
    if (needsClipboard && !this.clipboardTimer) {
      this.previousClipboardSignature = null;
      this.clipboardSequence = null;
      this.clipboardTimer = setInterval(() => this.pollClipboard(), 750);
    } else if (!needsClipboard && this.clipboardTimer) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = null;
      this.previousClipboardSignature = null;
      this.clipboardSequence = null;
    }
  }

  private startWorker(): void {
    if (this.disposed || !this.initialized || !this.needsWindowWorker() || this.workerRestartTimer) return;
    if (this.worker && !this.worker.killed) return;
    const worker = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', WINDOWS_SNAPSHOT_WORKER,
    ], { stdio: 'pipe', windowsHide: true });
    this.worker = worker;
    this.workerBuffer = '';
    this.workerReady = false;
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (this.worker === worker) this.handleWorkerOutput(String(chunk));
    });
    worker.stderr.on('data', chunk => console.error('[AutomationTriggers] Worker error:', String(chunk).trim()));
    let stopped = false;
    const handleStopped = (error?: Error): void => {
      if (stopped) return;
      stopped = true;
      if (error) console.error('[AutomationTriggers] Worker failed:', error);
      if (this.worker === worker) {
        this.worker = null;
        this.workerReady = false;
        this.notify();
        if (this.initialized && this.needsWindowWorker()) this.workerRestartTimer = setTimeout(() => {
          this.workerRestartTimer = null;
          this.startWorker();
        }, 2000);
      }
    };
    worker.once('error', handleStopped);
    worker.once('exit', () => handleStopped());
  }

  private handleWorkerOutput(chunk: string): void {
    this.workerBuffer += chunk;
    const lines = this.workerBuffer.split(/\r?\n/);
    this.workerBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'READY') {
        this.workerReady = true;
        this.notify();
        continue;
      }
      if (!line.startsWith('SNAPSHOT ')) continue;
      try {
        const payload = JSON.parse(Buffer.from(line.slice(9), 'base64').toString('utf8')) as {
          processes?: unknown;
          foreground?: unknown;
        };
        this.handleSnapshot(
          Array.isArray(payload.processes) ? payload.processes.map(String) : [],
          typeof payload.foreground === 'string' ? payload.foreground : '',
        );
      } catch (error) {
        console.error('[AutomationTriggers] Invalid worker snapshot:', error);
      }
    }
  }

  private handleSnapshot(processNames: string[], foreground: string): void {
    const current = new Set(processNames.map(normalizeProcessName).filter(Boolean));
    if (this.previousProcesses) {
      for (const processName of current) {
        if (!this.previousProcesses.has(processName)) void this.fireMatching('application-started', processName);
      }
      for (const processName of this.previousProcesses) {
        if (!current.has(processName)) void this.fireMatching('application-closed', processName);
      }
    }
    this.previousProcesses = current;

    if (foreground && foreground !== this.previousForeground) {
      this.previousForeground = foreground;
      const separator = foreground.indexOf('|');
      const processName = separator >= 0 ? foreground.slice(0, separator) : '';
      const title = separator >= 0 ? foreground.slice(separator + 1) : '';
      void this.fireMatching('window-focused', `${processName}|${title}`);
    }
    this.lastSnapshotAt = new Date().toISOString();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.tickRunning) return;
    this.tickRunning = true;
    try {
    const now = Date.now();
    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;
      if (trigger.type === 'schedule') {
        const intervalMs = Math.max(5, trigger.intervalSeconds) * 1000;
        const lastRun = trigger.lastRunAt ? new Date(trigger.lastRunAt).getTime() : 0;
        if (!this.runtimeFor(trigger.id).running && (!lastRun || now - lastRun >= intervalMs)) void this.scheduleRun(trigger);
      } else if (trigger.type === 'file-created' || trigger.type === 'file-modified' || trigger.type === 'file-deleted') {
        await this.pollFileTrigger(trigger);
      }
    }

    if (!this.triggers.some(trigger => trigger.enabled && trigger.type === 'network-connected')) return;
    const nextNetwork = networkConnections();
    if (!setsEqual(nextNetwork, this.previousNetwork)) {
      if ([...nextNetwork].some(connection => !this.previousNetwork.has(connection))) {
        void this.fireMatching('network-connected');
      }
      this.previousNetwork = nextNetwork;
    }
    } finally { this.tickRunning = false; }
  }

  private async pollFileTrigger(trigger: AutomationTrigger): Promise<void> {
    const filePath = trigger.matchValue;
    const previous = this.fileSnapshots.get(trigger.id);
    let current: FileSnapshot;
    try {
      const stat = await statFile(filePath);
      current = { exists: true, modifiedMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        trigger.lastError = 'Unable to inspect file; no deletion event was inferred.';
        return;
      }
      current = { exists: false, modifiedMs: 0, size: 0 };
    }
    this.fileSnapshots.set(trigger.id, current);
    if (!previous) return;
    if (trigger.type === 'file-created' && !previous.exists && current.exists) void this.scheduleRun(trigger);
    if (trigger.type === 'file-deleted' && previous.exists && !current.exists) void this.scheduleRun(trigger);
    if (trigger.type === 'file-modified' && previous.exists && current.exists
      && (previous.modifiedMs !== current.modifiedMs || previous.size !== current.size)) {
      void this.scheduleRun(trigger);
    }
  }

  private pollClipboard(): void {
    if (!this.triggers.some(trigger => trigger.enabled && trigger.type === 'clipboard-changed')) {
      this.previousClipboardSignature = null;
      this.clipboardSequence = null;
      return;
    }
    if (isClipboardExcluded()) { this.previousClipboardSignature = null; this.clipboardSequence = null; return; }
    const sample = this.getClipboardSource?.();
    const fresh = sample && sample.sequence > 0 && Date.now() - sample.sampledAt < 1500;
    if (fresh && this.previousClipboardSignature !== null && this.clipboardSequence
      && sample.sequence === this.clipboardSequence.sequence && sample.sampledAt > this.clipboardSequence.capturedAt) return;
    const formats = clipboard.availableFormats().sort();
    let contentHash = '';
    if (formats.some(format => format.startsWith('text/'))) {
      contentHash = createHash('sha256').update(clipboard.readText()).digest('hex');
    } else if (formats.some(format => format.includes('image'))) {
      const image = clipboard.readImage();
      const size = image.getSize();
      if (size.width * size.height > 16_000_000) return;
      contentHash = createHash('sha256').update(`${size.width}x${size.height}:`).update(image.toBitmap()).digest('hex');
    }
    this.clipboardSequence = fresh ? { sequence: sample.sequence, capturedAt: Date.now() } : null;
    const signature = `${formats.join(',')}|${contentHash}`;
    if (this.previousClipboardSignature === null) {
      this.previousClipboardSignature = signature;
      return;
    }
    if (signature !== this.previousClipboardSignature) {
      this.previousClipboardSignature = signature;
      void this.fireMatching('clipboard-changed');
    }
  }

  private async fireMatching(type: AutomationTriggerType, value = ''): Promise<void> {
    for (const trigger of this.triggers) {
      if (!trigger.enabled || trigger.type !== type || !matchesTrigger(trigger.matchValue, value, type)) continue;
      void this.scheduleRun(trigger);
    }
  }

  private scheduleRun(trigger: AutomationTrigger, manual = false): Promise<void> {
    const run = this.runTrigger(trigger, manual);
    this.activeRuns.add(run);
    void run.finally(() => this.activeRuns.delete(run)).catch(error => console.error('[AutomationTriggers]', error));
    return run;
  }

  private async runTrigger(trigger: AutomationTrigger, manual = false): Promise<void> {
    if (this.disposed) return;
    if (this.actions.getActivity?.().paused) return;
    const currentAtStart = this.triggers.find(item => item.id === trigger.id);
    if (!currentAtStart || (!manual && !currentAtStart.enabled)) return;
    trigger = currentAtStart;
    const runtime = this.runtimeFor(trigger.id);
    const lastRun = trigger.lastRunAt ? new Date(trigger.lastRunAt).getTime() : 0;
    if (runtime.running) {
      if (trigger.concurrency === 'queue-one') runtime.queued = true;
      this.notify();
      return;
    }
    if (runtime.timer) { if (!manual) return; clearTimeout(runtime.timer); runtime.timer = undefined; }
    if (!manual && lastRun && Date.now() - lastRun < trigger.cooldownSeconds * 1000) {
      if (trigger.concurrency === 'queue-one') {
        runtime.queued = true;
        runtime.timer = setTimeout(() => {
          runtime.timer = undefined;
          runtime.queued = false;
          void this.scheduleRun(trigger);
        }, Math.max(1, lastRun + trigger.cooldownSeconds * 1000 - Date.now()));
        this.notify();
      }
      return;
    }

    runtime.running = true;
    runtime.queued = false;
    this.notify();
    try {
      const result = await this.actions.execute(trigger.action);
      const current = this.triggers.find(item => item.id === trigger.id);
      if (current) {
        current.lastRunAt = new Date().toISOString();
        current.lastError = result.ok ? null : result.error ?? 'Action failed.';
        current.runCount += 1;
      }
    } catch (error) {
      const current = this.triggers.find(item => item.id === trigger.id);
      if (current) {
        current.lastRunAt = new Date().toISOString();
        current.lastError = error instanceof Error ? error.message : String(error);
        current.runCount += 1;
      }
    } finally {
      runtime.running = false;
      this.persist();
      this.notify();
      const current = this.triggers.find(item => item.id === trigger.id);
      if (!this.disposed && runtime.queued && current?.enabled) {
        runtime.queued = false;
        void this.scheduleRun(current);
      } else {
        runtime.queued = false;
      }
    }
  }

  private runtimeFor(id: string): TriggerRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { running: false, queued: false };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private readStore(): AutomationTrigger[] {
    if (!fs.existsSync(this.storePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isStoredTrigger)) throw new Error('Trigger store contains invalid records; original file retained.');
      return parsed.map(trigger => ({
        ...trigger,
        matchValue: trigger.type === 'application-started' || trigger.type === 'application-closed'
          ? normalizeProcessName(trigger.matchValue)
          : trigger.matchValue,
        running: false,
        queued: false,
      }));
    } catch (error) {
      throw new Error(`Could not read automation triggers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    writeJsonAtomicallySync(this.storePath, this.triggers.map(({ running: _running, queued: _queued, ...trigger }) => trigger));
  }

  private notify(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('triggers:changed');
    }
  }
}

function normalizeTrigger(input: AutomationTriggerInput): AutomationTrigger {
  const types: AutomationTriggerType[] = ['application-started', 'application-closed', 'window-focused', 'clipboard-changed', 'file-created', 'file-modified', 'file-deleted', 'monitor-connected', 'network-connected', 'windows-unlocked', 'schedule', 'winutils-started'];
  if (!input || typeof input.name !== 'string' || input.name.length > 200 || !types.includes(input.type)
    || typeof input.enabled !== 'boolean' || typeof input.matchValue !== 'string' || input.matchValue.length > 32768
    || !Number.isFinite(input.intervalSeconds) || !Number.isFinite(input.cooldownSeconds)
    || !['skip', 'queue-one'].includes(input.concurrency)
    || typeof input.action?.actionId !== 'string' || input.action.actionId.length > 512
    || (input.action.parameters !== undefined && (!input.action.parameters || typeof input.action.parameters !== 'object' || Array.isArray(input.action.parameters)))) {
    throw new Error('Invalid automation trigger.');
  }
  const name = input.name.trim();
  if (!name) throw new Error('Trigger name is required.');
  if (!input.action.actionId.trim()) throw new Error('Choose an action for the trigger.');
  const requiresValue: AutomationTriggerType[] = [
    'application-started',
    'application-closed',
    'window-focused',
    'file-created',
    'file-modified',
    'file-deleted',
  ];
  const matchValue = input.type === 'application-started' || input.type === 'application-closed'
    ? normalizeProcessName(input.matchValue)
    : input.matchValue.trim();
  if (requiresValue.includes(input.type) && !matchValue) throw new Error('This trigger requires a match value.');
  return {
    ...input,
    id: input.id ?? '',
    name,
    matchValue,
    intervalSeconds: Math.max(5, Math.min(31_536_000, Math.trunc(Number(input.intervalSeconds) || 60))),
    cooldownSeconds: Math.max(0, Math.min(86_400, Math.trunc(Number(input.cooldownSeconds) || 0))),
    concurrency: input.concurrency === 'queue-one' ? 'queue-one' : 'skip',
    lastRunAt: null,
    lastError: null,
    runCount: 0,
    running: false,
    queued: false,
  };
}

function matchesTrigger(expected: string, actual: string, type: AutomationTriggerType): boolean {
  if (type === 'application-started' || type === 'application-closed') return !expected || normalizeProcessName(expected) === normalizeProcessName(actual);
  if (!expected) return true;
  return actual.toLowerCase().includes(expected.toLowerCase());
}

function normalizeProcessName(value: string): string {
  return path.basename(value.trim()).replace(/\.exe$/i, '').toLowerCase();
}

function networkConnections(): Set<string> {
  return new Set(Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter(address => !address.internal)
      .map(address => `${name}:${address.family}:${address.address}`))
    .sort());
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(item => right.has(item));
}

function fileTriggerIdentity(trigger: Pick<AutomationTrigger, 'type' | 'matchValue'>): string {
  return trigger.type === 'file-created' || trigger.type === 'file-modified' || trigger.type === 'file-deleted'
    ? `${trigger.type}\0${trigger.matchValue.toLowerCase()}`
    : '';
}

function isStoredTrigger(value: unknown): value is AutomationTrigger {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AutomationTrigger>;
  try {
    normalizeTrigger(candidate as AutomationTriggerInput);
    return typeof candidate.id === 'string' && candidate.id.length <= 128
      && Number.isSafeInteger(candidate.runCount) && Number(candidate.runCount) >= 0
      && (candidate.lastRunAt === null || (typeof candidate.lastRunAt === 'string' && Number.isFinite(Date.parse(candidate.lastRunAt))));
  } catch { return false; }
}
