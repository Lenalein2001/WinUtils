import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import { stopWorkerGracefully } from './workerLifecycle';

export type NativeInputInstruction =
  | { kind: 'delay'; ms: number }
  | { kind: 'keyboard'; keys: number[]; mode: number; holdMs?: number }
  | { kind: 'mouse'; down: number; up: number; mode: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'text'; text: string }
  | { kind: 'repeat'; times: number; actions: NativeInputInstruction[] }
  | { kind: 'stop' };

export class NativeMacroCanceled extends Error {}
export class NativeMacroStopped extends Error {}
export type NativeHotkeyEvent = { kind: 'HOTKEY_DOWN' | 'HOTKEY_UP' | 'FAST_START' | 'FAST_END' | 'FAST_ERROR' | 'WORKER_EXIT'; hotkey: string; value: string; timestamp?: number };

/** A single persistent AOT process owns input ordering, precision and cleanup. */
export class NativeMacroWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private ready = false;
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; started: () => void }>();
  private readonly listeners = new Set<(event: NativeHotkeyEvent) => void>();
  readonly fastRuns = new Set<string>();

  isRunning(): boolean { return this.ready && this.child !== null; }
  onHotkey(listener: (event: NativeHotkeyEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async warm(): Promise<void> {
    await this.stopping;
    if (this.ready && this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async request(data: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<string> {
    signal?.throwIfAborted();
    await this.warm();
    signal?.throwIfAborted();
    const child = this.child;
    if (!child || !child.stdin.writable || child.killed) throw new Error('Native macro worker is unavailable.');
    if (this.pending.size >= 128) throw new Error('Macro input queue is full.');
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
    if (encoded.length > 8 * 1024 * 1024 - 128) throw new Error('Macro input batch exceeds its memory budget.');
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        // Cancellation travels on the independent command pipe while input is
        // executing. Wait for cleanup acknowledgement instead of abandoning it.
        child.stdin.write(`CANCEL ${String(data.runId)}\n`, error => { if (error) this.fail(child, error); });
      };
      const finish = (error?: Error, value = ''): void => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          finish(new Error('Native macro worker timed out.'));
          // EOF requests cancellation and cleanup before the bounded kill fallback.
          void this.stop().catch(error => console.error('[Macros] Cleanup failed:', error));
        }, Math.min(2_147_483_647, timeoutMs));
      };
      // A short macro queued behind a valid long macro must not kill that macro.
      // The execution deadline starts when the native input thread dequeues it.
      if (!['run', 'release', 'cancel-fast'].includes(String(data.op))) started();
      this.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error), started });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${id} ${encoded}\n`, error => { if (error) this.fail(child, error); });
      if (signal?.aborted) abort();
    });
  }

  async run(actions: NativeInputInstruction[], runId: string, signal: AbortSignal, maxActions = 100_000): Promise<number> {
    const duration = (items: NativeInputInstruction[]): number => items.reduce((total, item) => total + (
      item.kind === 'delay' ? item.ms : item.kind === 'repeat' ? item.times * duration(item.actions)
        : item.kind === 'text' ? item.text.length : item.kind === 'keyboard' && item.mode === 0 ? item.holdMs ?? 16
          : item.kind === 'mouse' && item.mode === 3 ? 50 : 0
    ), 0);
    // Long configured waits are valid; don't kill them after a fixed 30 seconds.
    return Number(await this.request({ op: 'run', runId, actions, maxActions }, signal, duration(actions) + 30_000));
  }

  async release(runId: string): Promise<void> {
    // A failed/terminated worker already ran shutdown cleanup. Do not spawn a
    // replacement just to release keys that it does not own.
    if (!this.ready || !this.child) return;
    await this.request({ op: 'release', runId });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.ready = false;
    this.fastRuns.clear();
    this.child = null;
    this.readyReject?.(new Error('Native macro worker stopped.'));
    for (const item of this.pending.values()) item.reject(new Error('Native macro worker stopped.'));
    this.pending.clear();
    this.stopping = stopWorkerGracefully(child, () => new Promise<void>((resolve, reject) => {
      child.stdin.write('__WINUTILS_EXIT__\n', error => error ? reject(error) : resolve());
    }), 5000).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private start(): Promise<void> {
    this.buffer = ''; this.stderr = '';
    const executable = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(),
      'resources', 'native', 'WinUtils.MacroWorker.exe');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.readyReject?.(new Error('Native macro worker startup timed out.')); void this.stop().catch(() => undefined); }, 10_000);
      const settle = (error?: Error): void => {
        clearTimeout(timer); this.readyResolve = null; this.readyReject = null;
        if (error) reject(error); else { this.ready = true; resolve(); }
      };
      this.readyResolve = () => settle(); this.readyReject = error => settle(error);
      const child = spawn(executable, [], { windowsHide: true, stdio: 'pipe' });
      this.child = child;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        this.buffer += chunk;
        if (this.buffer.length > 8 * 1024 * 1024) { this.fail(child, new Error('Native macro reply exceeds its memory budget.')); void this.stop().catch(() => undefined); return; }
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
          if (line === 'READY') { this.readyResolve?.(); continue; }
          const [status, id, encoded, timestamp] = line.split(' ');
          if (status === 'BEGIN') { this.pending.get(id)?.started(); continue; }
          if (['HOTKEY_DOWN', 'HOTKEY_UP', 'FAST_START', 'FAST_END', 'FAST_ERROR'].includes(status)) {
            const hotkey = Buffer.from(id ?? '', 'base64').toString('utf8');
            if (status === 'FAST_START') this.fastRuns.add(encoded);
            if (status === 'FAST_END') this.fastRuns.delete(encoded);
            const event: NativeHotkeyEvent = { kind: status as NativeHotkeyEvent['kind'], hotkey,
              value: status === 'FAST_ERROR' ? Buffer.from(encoded ?? '', 'base64').toString('utf8') : encoded ?? '',
              ...(timestamp ? { timestamp: Number(timestamp) } : {}) };
            for (const listener of this.listeners) { try { listener(event); } catch (error) { console.error('[Macros] Hotkey callback failed:', error); } }
            continue;
          }
          const request = this.pending.get(id);
          if (!request) continue;
          const value = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
          if (status === 'OK') request.resolve(value);
          else request.reject(status === 'CANCELED' ? new NativeMacroCanceled(value)
            : status === 'STOPPED' ? new NativeMacroStopped(value) : new Error(value || 'Native macro input failed.'));
        }
      });
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
      child.stdin.on('error', error => this.fail(child, error));
      child.once('error', error => this.fail(child, error));
      child.once('exit', (code, signal) => this.fail(child, new Error(`Native macro worker exited (${code ?? signal}). ${this.stderr}`)));
    });
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.ready = false;
    this.fastRuns.clear();
    this.readyReject?.(error);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    for (const listener of this.listeners) {
      try { listener({ kind: 'WORKER_EXIT', hotkey: '', value: error.message }); }
      catch (callbackError) { console.error('[Macros] Worker failure callback failed:', callbackError); }
    }
    // Keep the handle until bounded cleanup has been attempted on a live child.
    if (child.exitCode !== null || child.signalCode !== null) this.child = null;
    else void this.stop().catch(error => console.error('[Macros] Worker cleanup failed:', error));
  }
}

export const nativeMacroWorker = new NativeMacroWorker();
