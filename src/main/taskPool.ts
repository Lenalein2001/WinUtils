/** Bounded asynchronous work without blocking the main event loop. */
export class TaskPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
