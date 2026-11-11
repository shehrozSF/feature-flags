import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp } from '../src/http/app';
import { HubSession } from '../src/hub/hub-session';
import { memoryHubs } from '../src/hub/memory-hub';
import { createNotifier } from '../src/hub/notifier';
import { parseKey } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// The global cap (spec §9.2, ADR 0024): at most LIMITS.sandboxes live sandboxes.
// At the cap, creating one evicts the least recently active sandbox instead of
// refusing, so the demo never shows an error. Tests use a cap of 3.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
});
afterAll(() => db.drop());
beforeEach(() => db.pool.query('DELETE FROM projects'));

const CAP = 3;
const liveSandboxes = async () =>
  (await db.pool.query<{ id: string }>('SELECT id FROM projects WHERE owner_id IS NULL')).rows
    .map((r) => r.id)
    .sort();
const usedAgo = (id: string, minutes: number) =>
  db.pool.query(
    `UPDATE projects SET last_active_at = now() - $2 * interval '1 minute' WHERE id = $1`,
    [id, minutes],
  );

describe('the global sandbox cap', () => {
  it('at the cap, creating evicts the least recently active sandbox', async () => {
    const sandboxes = new SandboxService(repo, { cap: CAP });
    const ids = [];
    for (let i = 0; i < CAP; i++) ids.push((await sandboxes.create()).projectId);
    await usedAgo(ids[0]!, 5);
    await usedAgo(ids[1]!, 60); // least recently used
    await usedAgo(ids[2]!, 30);

    const created = await sandboxes.create();

    expect(created.evicted).toEqual([ids[1]]);
    expect(await liveSandboxes()).toEqual([ids[0]!, ids[2]!, created.projectId].sort());
  });

  it('below the cap nothing is evicted', async () => {
    const sandboxes = new SandboxService(repo, { cap: CAP });
    await sandboxes.create();
    expect((await sandboxes.create()).evicted).toEqual([]);
  });

  it('owned projects are never evicted or counted', async () => {
    const sandboxes = new SandboxService(repo, { cap: CAP });
    const owned = (await sandboxes.create()).projectId;
    await db.pool.query('UPDATE projects SET owner_id = gen_random_uuid() WHERE id = $1', [owned]);
    await usedAgo(owned, 10_000);
    for (let i = 0; i < CAP; i++) await sandboxes.create();

    expect((await sandboxes.create()).evicted).not.toContain(owned);
    expect((await liveSandboxes()).length).toBe(CAP);
  });

  it('concurrent creations at the cap stay at the cap', async () => {
    // Without serialising, each transaction counts the others' rows as not there
    // yet, and they all insert. Run several rounds: a race that passes once can
    // still be a race (issues #54).
    const sandboxes = new SandboxService(repo, { cap: CAP });
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 10 }, () => sandboxes.create()));
      expect((await liveSandboxes()).length, `round ${round}`).toBe(CAP);
    }
  });
});

describe('POST /v1/sandboxes at the cap', () => {
  it("the new sandbox works and the evicted one's keys are denied", async () => {
    const hub = memoryHubs();
    const snapshots = new PostgresSnapshotSource(repo);
    const session = new HubSession({
      hub,
      snapshots,
      postgresKeys: new PostgresKeyVerifier(repo),
      waitUntil: () => undefined,
    });
    const background: Promise<unknown>[] = [];
    const app = createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo, { cap: 1 }),
      rulesets: session,
      keys: session,
      notify: createNotifier({ hub, snapshots }),
      waitUntil: (p) => background.push(p),
      version: 'test',
    });
    const create = async () => {
      const res = await app.request('/v1/sandboxes', { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { keys: Record<'admin' | 'client', string> };
      expect(Object.keys(body)).not.toContain('evicted'); // other projects' ids stay private
      return body.keys;
    };

    const first = await create();
    expect(await session.verify(parseKey(first.client)!)).toBe(true); // hub now holds it
    const second = await create(); // evicts the first
    await Promise.all(background.splice(0));

    expect(await session.verify(parseKey(second.client)!)).toBe(true);
    expect(await session.verify(parseKey(first.client)!)).toBe(false); // hub cleared
  });
});
