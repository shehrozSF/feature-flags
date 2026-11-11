// After a committed write, push a fresh snapshot to the project's hub so SDKs see
// the change right away (ADR 0029). Never throws: the write already succeeded, and
// a failed push only delays propagation until the hub's staleness refresh.
import type { SnapshotSource } from '../domain/ports';
import { log } from '../log';
import type { HubClient } from './hub-client';
import { DEPENDENCY_TIMEOUT_MS, withTimeout } from './timeout';

/**
 * - `ok`: the hub has the change.
 * - `delayed`: the hub couldn't be updated; it catches up on its next stale read.
 * - `gone`: the project was deleted after the write (e.g. sandbox expiry); its hub was cleared.
 */
export type Propagation = 'ok' | 'delayed' | 'gone';
export type Notify = (projectId: string) => Promise<Propagation>;

export function createNotifier(deps: {
  hub: (projectId: string) => HubClient;
  snapshots: SnapshotSource;
  attempts?: number;
  /** Wait before the 2nd attempt; doubles each time after. */
  delayMs?: number;
  /** An attempt (load + hub call) slower than this counts as failed. */
  timeoutMs?: number;
}): Notify {
  const attempts = deps.attempts ?? 3;
  const firstDelay = deps.delayMs ?? 50;
  const timeoutMs = deps.timeoutMs ?? DEPENDENCY_TIMEOUT_MS;

  const attempt = async (projectId: string): Promise<Propagation> => {
    // Load again on every attempt: a newer write may have landed meanwhile.
    const snapshot = await deps.snapshots.load(projectId);
    if (!snapshot) {
      // Deleted (by expiry, eviction, or during a write). Its keys must stop working at once.
      log('warn', 'project gone; hub cleared', { projectId });
      await deps.hub(projectId).clear();
      return 'gone';
    }
    await deps.hub(projectId).update(snapshot);
    return 'ok';
  };

  return async (projectId) => {
    for (let n = 1; n <= attempts; n++) {
      try {
        return await withTimeout(attempt(projectId), timeoutMs, 'pushing to the hub');
      } catch (error) {
        log('error', 'hub push failed', { projectId, attempt: n, error });
        if (n < attempts) await sleep(firstDelay * 2 ** (n - 1));
      }
    }
    return 'delayed';
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
