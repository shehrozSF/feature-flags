// After a committed write, push a fresh snapshot to the project's hub so SDKs see
// the change right away (ADR 0029). Never throws: the write already succeeded, and
// a failed push only delays propagation until the hub's staleness refresh.
import type { SnapshotSource } from '../domain/ports';
import type { HubClient } from './hub-client';

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
}): Notify {
  const attempts = deps.attempts ?? 3;
  const firstDelay = deps.delayMs ?? 50;

  return async (projectId) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Load again on every attempt: a newer write may have landed meanwhile.
        const snapshot = await deps.snapshots.load(projectId);
        if (!snapshot) {
          // Deleted between our commit and now. Its keys must stop working at once.
          console.warn(`project ${projectId} was deleted during a write; clearing its hub`);
          await deps.hub(projectId).clear();
          return 'gone';
        }
        await deps.hub(projectId).update(snapshot);
        return 'ok';
      } catch (error) {
        console.error(error);
        if (attempt < attempts) await sleep(firstDelay * 2 ** (attempt - 1));
      }
    }
    return 'delayed';
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
