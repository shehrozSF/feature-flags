import { LIMITS } from '@ff/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { purgeExpired } from '../src/domain/purge';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp } from '../src/http/app';
import { memoryHubs } from '../src/hub/memory-hub';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// Sandbox lifetime (spec §9.2, ADR 0024): a sandbox lives 30 days past its last
// dashboard use, and an hourly cron deletes the ones whose time is up.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;
let sandboxes: SandboxService;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
  sandboxes = new SandboxService(repo);
});
afterAll(() => db.drop());

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = { last_active_at: Date; expires_at: Date | null };
const row = async (id: string) =>
  (await db.pool.query<Row>('SELECT last_active_at, expires_at FROM projects WHERE id = $1', [id]))
    .rows[0];
/** Moves a project's activity into the past, as if nobody had used it since. */
const age = (id: string, lastActiveAgoMs: number, expiresInMs: number | null) =>
  db.pool.query(
    `UPDATE projects SET last_active_at = now() - $2 * interval '1 millisecond',
       expires_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() + $3 * interval '1 millisecond' END
     WHERE id = $1`,
    [id, lastActiveAgoMs, expiresInMs],
  );
const count = async (table: string, projectId: string) =>
  Number(
    (
      await db.pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE project_id = $1`,
        [projectId],
      )
    ).rows[0]!.count,
  );

describe('activity: dashboard use keeps a sandbox alive', () => {
  const background: Promise<unknown>[] = [];
  const app = () =>
    createApp({
      flags: new FlagService(repo),
      sandboxes,
      rulesets: new PostgresRulesetSource(repo),
      keys: new PostgresKeyVerifier(repo),
      waitUntil: (p) => background.push(p),
      version: 'test',
    });
  const adminRequest = async (key: string) => {
    const res = await app().request('/v1/flags', { headers: { authorization: `Bearer ${key}` } });
    await Promise.all(background.splice(0)); // the activity write runs in the background
    return res;
  };

  it("an admin request extends a sandbox's expiry to 30 days from now", async () => {
    const { projectId, keys } = await sandboxes.create();
    await age(projectId, 2 * 60 * 60 * 1000, DAY_MS); // idle 2 h, 1 day left

    expect((await adminRequest(keys.admin)).status).toBe(200);

    const after = (await row(projectId))!;
    expect(Date.now() - after.last_active_at.getTime()).toBeLessThan(60_000);
    const expected = Date.now() + LIMITS.sandboxIdleDays * DAY_MS;
    expect(Math.abs(after.expires_at!.getTime() - expected)).toBeLessThan(60_000);
  });

  it('the activity write is handed to waitUntil, not left to luck', async () => {
    // In a Worker, work still running when the response is sent is cut off unless
    // it was given to ctx.waitUntil. Node (and the test above) would finish it
    // anyway, so check the hand-over itself with a write that hasn't finished yet.
    const { keys } = await sandboxes.create();
    let finish: () => void = () => undefined;
    const held = Object.create(sandboxes) as SandboxService;
    held.touch = () => new Promise<void>((resolve) => (finish = resolve));
    const handed: Promise<unknown>[] = [];
    const res = await createApp({
      flags: new FlagService(repo),
      sandboxes: held,
      rulesets: new PostgresRulesetSource(repo),
      keys: new PostgresKeyVerifier(repo),
      waitUntil: (p) => handed.push(p),
      version: 'test',
    }).request('/v1/flags', { headers: { authorization: `Bearer ${keys.admin}` } });

    expect(res.status).toBe(200); // answered while the write is still pending
    expect(handed).toHaveLength(1);
    finish();
    await Promise.all(handed);
  });

  it('a second admin request within the hour writes nothing', async () => {
    // At most one write per project per hour: the dashboard makes many requests.
    const { projectId, keys } = await sandboxes.create();
    await age(projectId, 10 * 60 * 1000, DAY_MS); // used 10 minutes ago
    const before = (await row(projectId))!;

    await adminRequest(keys.admin);

    expect(await row(projectId)).toEqual(before);
  });

  it('owned projects never get an expiry', async () => {
    const { projectId, keys } = await sandboxes.create();
    await db.pool.query('UPDATE projects SET owner_id = gen_random_uuid() WHERE id = $1', [
      projectId,
    ]);
    await age(projectId, 2 * 60 * 60 * 1000, null);

    await adminRequest(keys.admin);

    expect((await row(projectId))!.expires_at).toBeNull();
  });

  const down = () => Object.assign(new Error('down'), { code: 'ECONNRESET' });
  it.each([
    ['rejects', () => Promise.reject(down())],
    [
      'throws before returning a promise',
      () => {
        throw down();
      },
    ],
  ])('an activity write that %s never fails the request', async (_how, touch) => {
    const { keys } = await sandboxes.create();
    const broken = Object.create(sandboxes) as SandboxService;
    broken.touch = touch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await createApp({
      flags: new FlagService(repo),
      sandboxes: broken,
      rulesets: new PostgresRulesetSource(repo),
      keys: new PostgresKeyVerifier(repo),
      waitUntil: (p) => background.push(p),
      version: 'test',
    }).request('/v1/flags', { headers: { authorization: `Bearer ${keys.admin}` } });
    await Promise.all(background.splice(0));
    const logged = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();

    expect(res.status).toBe(200);
    expect(logged.some((line) => line.includes('activity write failed'))).toBe(true);
  });
});

describe('purgeExpired', () => {
  // Each test starts from an empty table: purge acts on the whole database.
  beforeEach(() => db.pool.query('DELETE FROM projects'));

  it('deletes only expired sandboxes, with their flags and keys', async () => {
    const expired = await sandboxes.create();
    const alive = await sandboxes.create();
    const owned = await sandboxes.create();
    await age(expired.projectId, 31 * DAY_MS, -DAY_MS);
    await age(owned.projectId, 365 * DAY_MS, null);

    const result = await purgeExpired({ repo, hub: memoryHubs(), batch: 100 });

    expect(result).toEqual({ deleted: 1 });
    expect(await row(expired.projectId)).toBeUndefined();
    expect(await count('flags', expired.projectId)).toBe(0);
    expect(await count('api_keys', expired.projectId)).toBe(0);
    expect(await row(alive.projectId)).toBeDefined();
    expect(await row(owned.projectId)).toBeDefined();
  });

  it("clears each deleted project's hub, after the delete is committed", async () => {
    const a = await sandboxes.create();
    const b = await sandboxes.create();
    await age(a.projectId, 31 * DAY_MS, -DAY_MS);
    await age(b.projectId, 31 * DAY_MS, -DAY_MS);
    const hubs = memoryHubs();
    const seenWhenCleared: Record<string, boolean> = {};
    for (const id of [a.projectId, b.projectId]) {
      const hub = hubs(id);
      const clear = hub.clear.bind(hub);
      hub.clear = async () => {
        // Cleared first and deleted later, a reload in between could refill the hub.
        seenWhenCleared[id] = (await row(id)) !== undefined;
        return clear();
      };
    }

    await purgeExpired({ repo, hub: hubs, batch: 100 });

    expect(seenWhenCleared).toEqual({ [a.projectId]: false, [b.projectId]: false });
    expect(await hubs(a.projectId).read('client', 'x')).toEqual({ status: 'denied' });
  });

  it('stops at the batch size, oldest first', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { projectId } = await sandboxes.create();
      await age(projectId, 40 * DAY_MS, -(3 - i) * DAY_MS); // ids[0] expired longest ago
      ids.push(projectId);
    }

    expect(await purgeExpired({ repo, hub: memoryHubs(), batch: 2 })).toEqual({ deleted: 2 });
    expect(await row(ids[0]!)).toBeUndefined();
    expect(await row(ids[1]!)).toBeUndefined();
    expect(await row(ids[2]!)).toBeDefined();
    expect(await purgeExpired({ repo, hub: memoryHubs(), batch: 2 })).toEqual({ deleted: 1 });
  });

  it('a failed hub clear does not undo the deletion or stop the others', async () => {
    const a = await sandboxes.create();
    const b = await sandboxes.create();
    await age(a.projectId, 31 * DAY_MS, -DAY_MS);
    await age(b.projectId, 31 * DAY_MS, -DAY_MS);
    const hubs = memoryHubs();
    hubs(a.projectId).clear = () => Promise.reject(new Error('hub unreachable'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await purgeExpired({ repo, hub: hubs, batch: 100 });
    const logged = errors.mock.calls.map(([line]) => String(line));
    errors.mockRestore();

    expect(result).toEqual({ deleted: 2 });
    expect(await row(a.projectId)).toBeUndefined(); // still deleted
    expect(await hubs(b.projectId).read('client', 'x')).toEqual({ status: 'denied' });
    // a's hub keeps serving until its staleness refresh finds the project gone.
    expect(logged.some((line) => line.includes('hub clear failed'))).toBe(true);
  });
});
