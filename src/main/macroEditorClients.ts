import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

/** Ask live editor contexts to finish saves before normal window/app shutdown. */
export class MacroEditorClients {
  private readonly clients = new Set<WebContents>();
  private readonly pending = new Map<string, { sender: WebContents; finish: (error?: Error) => void }>();
  private flushing: Promise<void> | null = null;
  constructor(private readonly timeoutMs = 20000) {}
  register(sender: WebContents): void {
    if (this.clients.has(sender)) return;
    this.clients.add(sender);
    const gone = (): void => {
      this.clients.delete(sender);
      for (const request of [...this.pending.values()]) if (request.sender === sender) request.finish(new Error('The macro editor closed before its saves finished.'));
    };
    sender.once('destroyed', gone); sender.once('render-process-gone', gone);
  }
  complete(sender: WebContents, token: unknown, error: unknown): void {
    if (typeof token !== 'string' || token.length > 128) throw new Error('Invalid editor save acknowledgement.');
    const request = this.pending.get(token);
    if (!request) return; // A cancelled/expired flush can acknowledge late.
    if (request.sender !== sender) throw new Error('Editor save acknowledgement does not belong to this window.');
    if (error !== null && error !== undefined && (typeof error !== 'string' || error.length > 2048)) throw new Error('Invalid editor save error.');
    request.finish(error ? new Error(String(error)) : undefined);
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = Promise.all([...this.clients].filter(sender => !sender.isDestroyed()).map(sender => new Promise<void>((resolve, reject) => {
      const token = randomUUID();
      const timer = setTimeout(() => finish(new Error('The macro editor did not finish saving. Retry after checking unsaved changes.')), this.timeoutMs);
      const finish = (error?: Error): void => { clearTimeout(timer); this.pending.delete(token); if (error) reject(error); else resolve(); };
      this.pending.set(token, { sender, finish });
      try { sender.send('macros:flushDrafts', token); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }))).then(() => undefined).catch(error => {
      this.cancel(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  cancel(error = new Error('Editor saves were interrupted by shutdown.')): void {
    for (const request of [...this.pending.values()]) request.finish(error);
    for (const sender of this.clients) if (!sender.isDestroyed()) {
      try { sender.send('macros:flushDrafts', null); } catch { /* Renderer failure must not prevent native cleanup. */ }
    }
  }
}
