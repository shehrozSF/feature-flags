// An in-memory HubClient: the ProjectHub's rules (shared via readState/updateState)
// without Durable Objects or sockets. Used by Node tests and the local Node server.
import type { ProjectSnapshot } from '../domain/ports';
import type { KeyKind } from '../keys';
import {
  DELETED,
  limitRead,
  readState,
  updateState,
  type HubClient,
  type HubRead,
  type RateWindow,
  type StoredHub,
} from './hub-client';

export class MemoryHub implements HubClient {
  private state: StoredHub | undefined;
  private window: RateWindow | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  read(kind: KeyKind, hashHex: string): Promise<HubRead> {
    const now = this.now();
    const { read, next } = readState(this.state, kind, hashHex, now);
    const limited = limitRead(read, kind, this.window, now);
    this.window = limited.window;
    if (limited.read.status === 'limited') return Promise.resolve(limited.read);
    if (next) this.state = next;
    return Promise.resolve(read);
  }

  update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }> {
    const { next, applied, version } = updateState(this.state, snapshot, this.now());
    if (next) this.state = next;
    return Promise.resolve({ applied, version });
  }

  clear(): Promise<void> {
    this.state = DELETED;
    return Promise.resolve();
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
