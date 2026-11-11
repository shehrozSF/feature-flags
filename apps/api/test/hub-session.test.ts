import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableError } from '../src/domain/errors';
import { FlagService } from '../src/domain/flags';
import type { SnapshotSource } from '../src/domain/ports';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { REFRESH_RETRY_MS, STALE_AFTER_MS } from '../src/hub/hub-client';
import { HubSession } from '../src/hub/hub-session';
import { memoryHubs } from '../src/hub/memory-hub';
import { parseKey, type KeyKind, type ParsedKey } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// HubSession against an in-memory hub and a real Postgres: the same logic the
// Worker runs, with MemoryHub standing in for the Durable Object (ADR 0029).
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;
let flags: FlagService;
let sandboxes: SandboxService;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
  flags = new FlagService(repo);
  sandboxes = new SandboxService(repo);
});
afterAll(() => db.drop());

/**
 * One shared set of hubs (like the Durable Object namespace), a factory for
 * per-request sessions, and the hubs' clock, which tests can move forward.
 */
function setup(options: { snapshots?: SnapshotSource } = {}) {
  const snapshots = options.snapshots ?? new PostgresSnapshotSource(repo);
  const postgresKeys = new PostgresKeyVerifier(repo);
  let now = Date.now();
  const hub = memoryHubs(() => now);
  const background: Promise<unknown>[] = [];
  const session = () =>
    new HubSession({ hub, snapshots, postgresKeys, waitUntil: (p) => background.push(p) });
  const advance = (ms: number) => {
    now += ms;
  };
  return { snapshots, postgresKeys, session, background, advance };
}

const sandbox = async () => {
  const { projectId, keys } = await sandboxes.create();
  const key = (kind: KeyKind): ParsedKey => parseKey(keys[kind])!;
  return { projectId, key };
};

describe('HubSession', () => {
  it('a cold hub is filled from Postgres on first read', async () => {
    const { snapshots, session } = setup();
    const load = vi.spyOn(snapshots, 'load');
    const { projectId, key } = await sandbox();

    const s = session();
    expect(await s.verify(key('client'))).toBe(true);
    const ruleset = await s.getRuleset(projectId);
    expect(Object.keys(ruleset!.flags)).toHaveLength(4);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a warm hub doesn't touch Postgres", async () => {
    const { snapshots, session } = setup();
    const { projectId, key } = await sandbox();
    const first = session();
    await first.verify(key('server'));

    const load = vi.spyOn(snapshots, 'load');
    const second = session();
    expect(await second.verify(key('server'))).toBe(true);
    expect((await second.getRuleset(projectId))!.projectVersion).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('admin keys are always checked in Postgres', async () => {
    const { postgresKeys, snapshots, session } = setup();
    const verify = vi.spyOn(postgresKeys, 'verify');
    const load = vi.spyOn(snapshots, 'load');
    const { key } = await sandbox();

    expect(await session().verify(key('admin'))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled(); // the hub isn't involved
  });

  it('a wrong key for a real project is denied', async () => {
    const { session } = setup();
    const { projectId } = await sandbox();
    const forged: ParsedKey = { kind: 'client', projectId, secret: 'A'.repeat(43) };
    expect(await session().verify(forged)).toBe(false);
  });

  it('a stale hub answers immediately and refreshes in the background', async () => {
    const { session, background, advance } = setup();
    const { projectId, key } = await sandbox();
    await session().verify(key('client')); // hub now holds version 1

    // A write the hub never heard about (pushing after writes is Task 6).
    await flags.update(projectId, (await flags.list(projectId))[0]!.key, 1, { enabled: false });

    advance(STALE_AFTER_MS + 60_000);
    const stale = session();
    expect(await stale.verify(key('client'))).toBe(true);
    expect((await stale.getRuleset(projectId))!.projectVersion).toBe(1); // old, but instant
    expect(background).toHaveLength(1);

    await Promise.all(background);
    const fresh = session();
    await fresh.verify(key('client'));
    expect((await fresh.getRuleset(projectId))!.projectVersion).toBe(2);
  });

  it('a stale refresh that finds the project deleted clears the hub', async () => {
    const { session, background, advance } = setup();
    const { projectId, key } = await sandbox();
    await session().verify(key('client')); // hub holds the project
    await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    advance(STALE_AFTER_MS + 60_000);
    await session().verify(key('client')); // stale: answered, refresh scheduled
    await Promise.all(background);
    warn.mockRestore();

    // The refresh found no project and emptied the hub, so the key stops working.
    expect(await session().verify(key('client'))).toBe(false);
  });

  it('only one request per stale window starts a refresh', async () => {
    // Otherwise every request past the mark loads from Postgres, and a database
    // outage turns each SDK request into a failing query (final review, I-3).
    const { snapshots, session, background, advance } = setup();
    const { key } = await sandbox();
    await session().verify(key('client'));
    const load = vi.spyOn(snapshots, 'load').mockImplementation(() => new Promise(() => undefined));

    advance(STALE_AFTER_MS + 60_000);
    for (let i = 0; i < 5; i++) expect(await session().verify(key('client'))).toBe(true);

    expect(background).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a refresh that never lands is retried after a while, not on every request', async () => {
    const { snapshots, session, background, advance } = setup();
    const { key } = await sandbox();
    await session().verify(key('client'));
    vi.spyOn(snapshots, 'load').mockImplementation(() => new Promise(() => undefined));

    advance(STALE_AFTER_MS + 60_000);
    await session().verify(key('client')); // claims the refresh
    advance(REFRESH_RETRY_MS - 1_000);
    await session().verify(key('client')); // still claimed
    expect(background).toHaveLength(1);
    advance(2_000);
    await session().verify(key('client')); // claim expired: try again
    expect(background).toHaveLength(2);
  });

  it('a fresh hub schedules no background work', async () => {
    const { session, background } = setup();
    const { key } = await sandbox();
    await session().verify(key('client'));
    await session().verify(key('client'));
    expect(background).toHaveLength(0);
  });

  it('cold hub with an unreachable database gives 503', async () => {
    const down: SnapshotSource = {
      // Shaped like Node's real error: the cause is in `code`.
      load: () =>
        Promise.reject(
          Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
        ),
    };
    const { session } = setup({ snapshots: down });
    const { key } = await sandbox();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(session().verify(key('client'))).rejects.toBeInstanceOf(ServiceUnavailableError);
    // The real cause is logged on the server (by code); the client only sees "try again".
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({
      event: 'snapshot load failed',
      errorCode: 'ECONNREFUSED',
    });
    errors.mockRestore();
  });

  it('a database that never answers gives 503 after the timeout', async () => {
    // Spec §7: "unavailable or slow" → 503. A hung query must not hang the request.
    const hung: SnapshotSource = { load: () => new Promise(() => undefined) };
    const { key } = await sandbox();
    const session = new HubSession({
      hub: memoryHubs(),
      snapshots: hung,
      postgresKeys: new PostgresKeyVerifier(repo),
      waitUntil: () => undefined,
      loadTimeoutMs: 50,
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(session.verify(key('client'))).rejects.toBeInstanceOf(ServiceUnavailableError);
    errors.mockRestore();
  });

  it('unknown project is denied, not an error', async () => {
    const { session } = setup();
    const ghost: ParsedKey = {
      kind: 'server',
      projectId: '00000000-0000-4000-8000-000000000000',
      secret: 'A'.repeat(43),
    };
    expect(await session().verify(ghost)).toBe(false);
  });
});
