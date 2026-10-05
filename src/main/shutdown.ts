/** Idempotent cleanup; one failing subsystem must not skip the others. */
export function createShutdown(tasks: Record<string, () => void | Promise<void>>, report: (name: string, error: unknown) => void): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    await Promise.all(Object.entries(tasks).map(async ([name, task]) => {
      try { await task(); } catch (error) { report(name, error); }
    }));
  })();
}
