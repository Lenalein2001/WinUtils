/** A damaged optional module must not prevent Startup Apps and recovery tools from opening. */
export function createOptionalModule<T extends object>(name: string, create: () => T,
  report: (name: string, error: unknown) => void): T {
  try { return create(); }
  catch (error) {
    report(name, error);
    const failure = new Error(`${name} is unavailable. Its original data was preserved. ${error instanceof Error ? error.message : String(error)}`);
    // No replacement manager is initialized or allowed to overwrite the original store.
    // IPC calls retain their contract and fail with an actionable module-specific error.
    return new Proxy({} as T, { get: (_target, key) => {
      if (key === 'then') return undefined;
      if (['init', 'startPolling', 'destroy', 'dispose', 'stopPolling'].includes(String(key))) return () => Promise.resolve();
      return () => Promise.reject(failure);
    } });
  }
}
