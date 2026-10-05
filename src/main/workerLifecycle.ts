import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Pipe delivery is not cleanup acknowledgement. Wait for the reply and exit. */
export async function stopWorkerGracefully(
  worker: ChildProcessWithoutNullStreams,
  requestShutdown: () => Promise<unknown>,
  timeoutMs = 15_000,
): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout>;
  let onExit: (code: number | null) => void;
  let onError: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => {
    onExit = code => code === 0 ? resolve() : reject(new Error(`Worker shutdown exited with code ${code}.`));
    onError = reject;
    worker.once('exit', onExit);
    worker.once('error', onError);
  });
  // A rejection can arrive while the shutdown request is still awaiting its reply.
  void exit.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Worker cleanup timed out; restoration may be incomplete.')), timeoutMs);
  });
  try {
    await Promise.race([(async () => { await requestShutdown(); worker.stdin.end(); await exit; })(), timeout]);
  } catch (error) {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    throw error;
  } finally {
    clearTimeout(timer!);
    worker.removeListener('exit', onExit!);
    worker.removeListener('error', onError!);
  }
}
