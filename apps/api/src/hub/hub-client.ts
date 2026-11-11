// How the Worker talks to a project's hub (ADR 0029). The ProjectHub Durable
// Object implements it in production, MemoryHub in Node tests. No Cloudflare
// imports here: this file is shared by both.
import { LIMITS } from '@ff/contracts';
import type { Ruleset } from '@ff/eval-core';
import type { ProjectSnapshot } from '../domain/ports';
import type { KeyKind } from '../keys';

export type HubRead =
  /** No snapshot yet: the caller loads one from Postgres and pushes it. */
  | { status: 'cold' }
  /** The hub has a snapshot, and this key hash isn't in it for that kind. */
  | { status: 'denied' }
  /**
   * loadedAt: ms since epoch when the snapshot was last loaded or confirmed.
   * refresh: the snapshot is stale and THIS reader should reload it in the
   * background. The hub tells only one reader per REFRESH_RETRY_MS.
   */
  | { status: 'ok'; ruleset: Ruleset; loadedAt: number; refresh: boolean }
  /** Too many client reads (evaluates) this minute; nothing served. */
  | { status: 'limited'; retryAfterMs: number };

export interface HubClient {
  read(kind: KeyKind, hashHex: string): Promise<HubRead>;
  /**
   * Applied only if newer than what the hub holds (or it holds nothing). The same
   * version refreshes loadedAt; an older one is ignored. Returns the hub's version after.
   */
  update(snapshot: ProjectSnapshot): Promise<{ applied: boolean; version: number }>;
  /**
   * The project no longer exists: forget the snapshot (so its keys stop working)
   * and close every socket with PROJECT_DELETED. The hub keeps a permanent
   * "deleted" marker: it denies every key and refuses every later snapshot, so a
   * reload that started before the deletion can't bring the project back.
   */
  clear(): Promise<void>;
}

/** WebSocket close code sent when a hub is cleared (4000–4999 are application codes). */
export const PROJECT_DELETED = 4404;

/** Hub limits from spec §7. */
export const MAX_SOCKETS_PER_PROJECT = 100;

/**
 * Serve a snapshot older than this, but have one reader reload it in the background.
 * Writes push to the hub at once, so this only heals a failed push. Spec §7 says
 * 5 min; 30 min stops a steady SDK user from keeping Neon (which suspends after
 * 5 idle min) awake around the clock and exhausting its free compute (D27).
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** After asking a reader to refresh, wait this long before asking another (the refresh may have failed). */
export const REFRESH_RETRY_MS = 60 * 1000;

/** What a hub keeps: the latest snapshot, when it was loaded or confirmed, and any refresh in flight. */
export type HubState = { snapshot: ProjectSnapshot; loadedAt: number; refreshClaimedAt?: number };

/**
 * What a cleared hub stores instead of a HubState. Permanent: project ids are
 * random UUIDs that are never reused, so it can't block a real project, and it
 * costs a few bytes per deleted project.
 */
export const DELETED = { deleted: true } as const;

/** A fixed window of client reads, kept in the hub's memory (see limitRead). */
export type RateWindow = { start: number; count: number };
export const RATE_WINDOW_MS = 60_000;

/**
 * The evaluate limit (spec §9.2), applied to a read readState already answered.
 * Only reads that would be served with a client key count: server SDKs fetch
 * rules rarely and are left alone, and denied keys don't use up the project's
 * allowance. The window lives in memory, not storage, so an evaluate costs no
 * Durable Object write; it resets if the hub leaves memory, which is fine for an
 * abuse limit.
 */
export function limitRead(
  read: HubRead,
  kind: KeyKind,
  window: RateWindow | undefined,
  now: number,
  limit: number = LIMITS.evaluatesPerMinute,
): { read: HubRead; window: RateWindow | undefined } {
  if (read.status !== 'ok' || kind !== 'client') return { read, window };
  const current = window && now - window.start < RATE_WINDOW_MS ? window : { start: now, count: 0 };
  if (current.count >= limit) {
    return {
      read: { status: 'limited', retryAfterMs: current.start + RATE_WINDOW_MS - now },
      window: current,
    };
  }
  return { read, window: { start: current.start, count: current.count + 1 } };
}
export type StoredHub = HubState | typeof DELETED;

const isDeleted = (state: StoredHub | undefined): state is typeof DELETED =>
  state !== undefined && 'deleted' in state;

// The hub's rules as pure functions, shared by ProjectHub and MemoryHub so the
// in-memory stand-in used by Node tests can't drift from the real one.

/** `next` is what to store (undefined = nothing changed): set when this read claims the refresh. */
export function readState(
  state: StoredHub | undefined,
  kind: KeyKind,
  hashHex: string,
  now: number,
): { read: HubRead; next: HubState | undefined } {
  if (!state) return { read: { status: 'cold' }, next: undefined };
  if (isDeleted(state)) return { read: { status: 'denied' }, next: undefined };
  const known = state.snapshot.keys.some((k) => k.kind === kind && k.hashHex === hashHex);
  if (!known) return { read: { status: 'denied' }, next: undefined };

  const stale = now - state.loadedAt > STALE_AFTER_MS;
  const claimed =
    state.refreshClaimedAt !== undefined && now - state.refreshClaimedAt < REFRESH_RETRY_MS;
  const refresh = stale && !claimed;
  return {
    read: { status: 'ok', ruleset: state.snapshot.ruleset, loadedAt: state.loadedAt, refresh },
    next: refresh ? { ...state, refreshClaimedAt: now } : undefined,
  };
}

/**
 * `next` is what to store (undefined = keep the current state); `applied` = the version went up.
 * A deleted hub refuses everything and reports version 0.
 */
export function updateState(
  state: StoredHub | undefined,
  snapshot: ProjectSnapshot,
  now: number,
): { next: HubState | undefined; applied: boolean; version: number } {
  if (isDeleted(state)) return { next: undefined, applied: false, version: 0 };
  const have = state?.snapshot.ruleset.projectVersion;
  const incoming = snapshot.ruleset.projectVersion;
  // Snapshots can arrive out of order (two writes race to push); never go back.
  if (have !== undefined && incoming < have) {
    return { next: undefined, applied: false, version: have };
  }
  // Same version: same flags, but keys may have changed and loadedAt marks it fresh.
  const next = { snapshot, loadedAt: now };
  if (have !== undefined && incoming === have) return { next, applied: false, version: have };
  return { next, applied: true, version: incoming };
}
