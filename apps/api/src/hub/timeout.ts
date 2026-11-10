// Spec §7: a dependency that is "unavailable or slow" is treated as unavailable.
// Waiting on a hung query or a hub that never answers would hang the request.

/** How long a snapshot load or a hub call may take before we give up. */
export const DEPENDENCY_TIMEOUT_MS = 5_000;

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError after `ms`. The work itself isn't cancelled, only no longer awaited. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
