// An in-memory HubClient: the ProjectHub's rules (shared via readState/updateState)
// without Durable Objects or sockets. Used by Node tests and the local Node server.
import type { ProjectSnapshot } from '../domain/ports';
import type { KeyKind } from '../keys';
import { readState, updateState, type HubClient, type HubRead, type HubState } from './hub-client';

export class MemoryHub implements HubClient {
  private state: HubState | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  read(kind: KeyKind, hashHex: string): Promise<HubRead> {
    return Promise.resolve(readState(this.state, kind, hashHex));
  }

  update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }> {
    const { next, applied, version } = updateState(this.state, snapshot, this.now());
    if (next) this.state = next;
    return Promise.resolve({ applied, version });
  }
}

/** One MemoryHub per project id, created on first use (like a Durable Object namespace). */
export function memoryHubs(now?: () => number): (projectId: string) => MemoryHub {
  const hubs = new Map<string, MemoryHub>();
  return (projectId) => {
    let hub = hubs.get(projectId);
    if (!hub) {
      hub = new MemoryHub(now);
      hubs.set(projectId, hub);
    }
    return hub;
  };
}
