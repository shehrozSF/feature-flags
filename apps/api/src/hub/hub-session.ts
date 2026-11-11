// SDK reads through the project hub (ADR 0028, 0029). One HubSession per request:
// it verifies the key and remembers the ruleset that came with it, so the route's
// getRuleset() in the same request costs no second hub call.
import type { Ruleset } from '@ff/eval-core';
import { ServiceUnavailableError } from '../domain/errors';
import type { KeyVerifier, ProjectSnapshot, RulesetSource, SnapshotSource } from '../domain/ports';
import { hashSecret, toHex, type ParsedKey } from '../keys';
import { log } from '../log';
import type { HubClient } from './hub-client';
import { DEPENDENCY_TIMEOUT_MS, withTimeout } from './timeout';

export type HubSessionDeps = {
  hub: (projectId: string) => HubClient;
  snapshots: SnapshotSource;
  /** Admin keys always go to Postgres (spec §6.2): the hub only knows SDK keys' use. */
  postgresKeys: KeyVerifier;
  /** Keeps background work alive after the response (ctx.waitUntil on Workers). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Snapshot loads slower than this count as "database unavailable" (503). */
  loadTimeoutMs?: number;
};

export class HubSession implements RulesetSource, KeyVerifier {
  private readonly rulesets = new Map<string, Ruleset>();

  constructor(private readonly deps: HubSessionDeps) {}

  async verify(key: ParsedKey): Promise<boolean> {
    if (key.kind === 'admin') return this.deps.postgresKeys.verify(key);

    const hub = this.deps.hub(key.projectId);
    const hashHex = toHex(await hashSecret(key.secret));
    let read = await hub.read(key.kind, hashHex);
    if (read.status === 'cold') {
      const snapshot = await this.load(key.projectId);
      if (!snapshot) return false; // unknown project: deny, like an unknown key
      await hub.update(snapshot);
      read = await hub.read(key.kind, hashHex);
    }
    if (read.status !== 'ok') return false;

    this.rulesets.set(key.projectId, read.ruleset);
    if (read.refresh) {
      // Stale, and the hub picked this request to reload it (one per window).
      // Answer now with what we have; the next request gets the refreshed snapshot.
      this.deps.waitUntil(this.refresh(key.projectId, hub));
    }
    return true;
  }

  async getRuleset(projectId: string): Promise<Ruleset | null> {
    const remembered = this.rulesets.get(projectId);
    if (remembered) return remembered;
    // Not verified through this session (SDK routes always are): read Postgres directly.
    return (await this.load(projectId))?.ruleset ?? null;
  }

  private async load(projectId: string): Promise<ProjectSnapshot | null> {
    try {
      return await withTimeout(
        this.deps.snapshots.load(projectId),
        this.deps.loadTimeoutMs ?? DEPENDENCY_TIMEOUT_MS,
        'loading the project snapshot',
      );
    } catch (error) {
      // Nothing cached and no database (down or too slow): tell clients to retry
      // (spec §7, §9.1), not 500.
      log('error', 'snapshot load failed', { projectId, error });
      throw new ServiceUnavailableError();
    }
  }

  private async refresh(projectId: string, hub: HubClient): Promise<void> {
    try {
      const snapshot = await this.deps.snapshots.load(projectId);
      if (snapshot) {
        await hub.update(snapshot);
      } else {
        // Deleted since the hub loaded it: stop serving it and stop accepting its keys.
        log('warn', 'project gone; hub cleared', { projectId });
        await hub.clear();
      }
    } catch (error) {
      // Background only: the stale snapshot keeps serving, and the next stale read retries.
      log('error', 'background refresh failed', { projectId, error });
    }
  }
}
