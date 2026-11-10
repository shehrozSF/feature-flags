// After a committed write, push a fresh snapshot to the project's hub so SDKs see
// the change right away (ADR 0029). Never throws: the write already succeeded, and
// a failed push only delays propagation until the hub's staleness refresh.
import type { SnapshotSource } from '../domain/ports';
import type { HubClient } from './hub-client';

/** Resolves false if the hub couldn't be updated (the response is then marked delayed). */
export type Notify = (projectId: string) => Promise<boolean>;

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
        if (!snapshot) return true; // project gone: nothing to propagate
        await deps.hub(projectId).update(snapshot);
        return true;
      } catch (error) {
        console.error(error);
        if (attempt < attempts) await sleep(firstDelay * 2 ** (attempt - 1));
      }
    }
    return false;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
