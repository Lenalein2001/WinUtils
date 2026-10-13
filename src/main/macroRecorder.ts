import type { MacroRecordingOptions, MacroRecordingState } from '../shared/macroRecording';
import { nativeMacroWorker } from './nativeMacroWorker';
import { SerialTaskQueue } from './atomicFile';
import { validateTimeline } from './macroTimeline';

const idle = (): MacroRecordingState => ({ phase: 'idle', eventCount: 0, dropped: 0, elapsedMs: 0, countdownMs: 0, error: null, draft: null });
export class MacroRecorder {
  private readonly queue = new SerialTaskQueue();
  private state = idle();
  private pendingStart = false;
  private saved: { result: unknown } | null = null;
  private workerEpoch: number | null = null;
  private unsubscribe = nativeMacroWorker.onHotkey(event => {
    if (event.kind === 'WORKER_EXIT' && this.state.phase !== 'idle')
      this.state = { ...this.state, phase: 'ready', error: this.state.draft ? null : 'Recording worker stopped. Unsaved captured input could not be recovered.' };
  });
  get busy(): boolean { return this.pendingStart || this.state.phase !== 'idle'; }
  start(options: MacroRecordingOptions, beforeStart: () => Promise<void>): Promise<MacroRecordingState> {
    if (this.busy) return Promise.reject(new Error('Save or discard the current recording first.'));
    if (!options || !['keyboard', 'mouse', 'movement'].every(key => typeof options[key as keyof MacroRecordingOptions] === 'boolean')
      || (!options.keyboard && !options.mouse) || !Number.isSafeInteger(options.countdownSeconds) || options.countdownSeconds < 0 || options.countdownSeconds > 10
      || !Array.isArray(options.excludedProcesses) || options.excludedProcesses.length > 100
      || options.excludedProcesses.some(name => typeof name !== 'string' || !name.trim() || name.length > 128 || /[\0\\/]/.test(name))) return Promise.reject(new Error('Invalid recording options.'));
    this.pendingStart = true;
    return this.queue.run(async () => {
      try {
        await beforeStart();
        this.state = JSON.parse(await nativeMacroWorker.request({ op: 'record-start', keyboard: options.keyboard, mouse: options.mouse,
          movement: options.movement, countdownSeconds: options.countdownSeconds, excludedProcesses: options.excludedProcesses, ownerPid: process.pid })) as MacroRecordingState;
        this.workerEpoch = nativeMacroWorker.epoch;
        return this.state;
      } finally { this.pendingStart = false; }
    });
  }
  status(): Promise<MacroRecordingState> {
    return this.queue.run(async () => {
      this.checkWorker();
      if (this.state.phase === 'idle' || this.state.draft || this.state.error) return this.state;
      this.state = JSON.parse(await nativeMacroWorker.request({ op: 'record-status' })) as MacroRecordingState;
      if (this.state.phase === 'ready') await this.finish();
      return this.state;
    });
  }
  stop(): Promise<MacroRecordingState> {
    return this.queue.run(async () => {
      this.checkWorker();
      if (this.state.phase !== 'idle' && !this.state.draft && !this.state.error) await this.finish();
      return this.state;
    });
  }
  private checkWorker(): void {
    if (this.state.phase !== 'idle' && !this.state.draft && !this.state.error
      && (!nativeMacroWorker.isRunning() || this.workerEpoch !== nativeMacroWorker.epoch))
      this.state = { ...this.state, phase: 'ready', error: 'Recording worker stopped or restarted. Unsaved captured input could not be recovered.' };
  }
  private async finish(): Promise<void> {
    this.state = JSON.parse(await nativeMacroWorker.request({ op: 'record-stop' })) as MacroRecordingState;
    if (this.state.draft) validateTimeline(this.state.draft);
  }
  discard(): Promise<MacroRecordingState> {
    return this.queue.run(async () => {
      if (nativeMacroWorker.isRunning() && this.state.phase !== 'idle') await nativeMacroWorker.request({ op: 'record-discard' });
      this.state = idle(); this.saved = null; return this.state;
    });
  }
  async destroy(): Promise<void> {
    try { await this.discard(); }
    catch (error) { await nativeMacroWorker.stop(); throw error; }
    finally { this.unsubscribe(); }
  }
  save<T>(persist: (state: MacroRecordingState) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      this.checkWorker();
      if (this.state.phase !== 'idle' && !this.state.draft && !this.state.error) await this.finish();
      const result = this.saved ? this.saved.result as T : await persist(this.state);
      this.saved = { result };
      try { if (nativeMacroWorker.isRunning()) await nativeMacroWorker.request({ op: 'record-discard' }); }
      catch { throw new Error('Macro was saved, but recorder cleanup failed. Retry Save or Discard to finish cleanup.'); }
      this.state = idle(); this.saved = null; return result;
    });
  }
}
