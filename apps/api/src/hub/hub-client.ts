// How the Worker talks to a project's hub (ADR 0029). The ProjectHub Durable
// Object implements it in production, MemoryHub in Node tests. No Cloudflare
// imports here: this file is shared by both.
import type { Ruleset } from '@ff/eval-core';
import type { ProjectSnapshot } from '../domain/ports';
import type { KeyKind } from '../keys';

export type HubRead =
  /** No snapshot yet: the caller loads one from Postgres and pushes it. */
  | { status: 'cold' }
  /** The hub has a snapshot, and this key hash isn't in it for that kind. */
  | { status: 'denied' }
  /** loadedAt: ms since epoch when the snapshot was last loaded or confirmed. */
  | { status: 'ok'; ruleset: Ruleset; loadedAt: number };

export interface HubClient {
  read(kind: KeyKind, hashHex: string): Promise<HubRead>;
  /**
   * Applied only if newer than what the hub holds (or it holds nothing). The same
   * version refreshes loadedAt; an older one is ignored. Returns the hub's version after.
   */
  update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }>;
}

/** Hub limits from spec §7. */
export const MAX_SOCKETS_PER_PROJECT = 100;
