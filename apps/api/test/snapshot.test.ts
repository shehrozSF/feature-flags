import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagService } from '../src/domain/flags';
import type { ProjectSnapshot } from '../src/domain/ports';
import { PostgresSnapshotSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { hashSecret, parseKey, toHex } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;
let flags: FlagService;
let sandboxes: SandboxService;
let snapshots: PostgresSnapshotSource;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
  flags = new FlagService(repo);
  sandboxes = new SandboxService(repo);
  snapshots = new PostgresSnapshotSource(repo);
});
afterAll(() => db.drop());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pool whose clients wait before every query. Snapshot reads go through it, so
 * concurrent writes reliably land *between* the snapshot's queries: exactly the
 * moment a non-repeatable read would mix two states.
 */
type AnyFn = (...args: unknown[]) => unknown;
// Methods must run with the real object as `this`, not the proxy.
const bound = (value: unknown, target: object): unknown =>
  typeof value === 'function' ? (value as AnyFn).bind(target) : value;

function slowPool(pool: pg.Pool, ms: number): pg.Pool {
  const slowClient = (client: pg.PoolClient) =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            await sleep(ms);
            return (target.query as AnyFn).apply(target, args);
          };
        }
        return bound(value, target);
      },
    });
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'connect') return async () => slowClient(await target.connect());
      const value: unknown = Reflect.get(target, prop, receiver);
      return bound(value, target);
    },
  });
}

const flagInput = (key: string) => ({
  key,
  name: key,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  defaultServe: { variant: 'on' },
});

describe('PostgresSnapshotSource', () => {
  it('snapshot of a new sandbox has 4 flags, version 1 and 3 key hashes', async () => {
    const { projectId, keys } = await sandboxes.create();
    const snap = await snapshots.load(projectId);

    expect(snap!.ruleset.projectVersion).toBe(1);
    expect(Object.keys(snap!.ruleset.flags)).toHaveLength(4);

    const expected = await Promise.all(
      Object.values(keys).map(async (raw) => {
        const parsed = parseKey(raw)!;
        return { kind: parsed.kind, hashHex: toHex(await hashSecret(parsed.secret)) };
      }),
    );
    const byKind = (a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind);
    expect([...snap!.keys].sort(byKind)).toEqual(expected.sort(byKind));
    expect(snap!.keys[0]!.hashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('revoked keys are left out', async () => {
    const { projectId } = await sandboxes.create();
    await db.pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE project_id = $1 AND kind = 'server'`,
      [projectId],
    );
    const snap = await snapshots.load(projectId);
    expect(snap!.keys.map((k) => k.kind).sort()).toEqual(['admin', 'client']);
  });

  it('archived flags are left out', async () => {
    const { projectId } = await sandboxes.create();
    const [first] = Object.keys((await snapshots.load(projectId))!.ruleset.flags);
    await flags.archive(projectId, first!, 1);
    const snap = await snapshots.load(projectId);
    expect(Object.keys(snap!.ruleset.flags)).toHaveLength(3);
    expect(snap!.ruleset.flags[first!]).toBeUndefined();
  });

  it('unknown project gives null', async () => {
    expect(await snapshots.load('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('version and flags always match under concurrent writes', async () => {
    const { projectId } = await sandboxes.create();
    const keys = Array.from({ length: 20 }, (_, i) => `race-${String(i).padStart(2, '0')}`);
    for (const key of keys.slice(4)) await flags.create(projectId, flagInput(key));
    const seeded = Object.keys((await snapshots.load(projectId))!.ruleset.flags);
    const targets = [...seeded, ...keys.slice(4)].slice(0, 20);
    const base = (await repo.projectVersion(projectId))!;

    // Every write bumps one flag's version and the project's version once, so in
    // any consistent snapshot: projectVersion = base + Σ(flag.version − 1).
    const consistent = (s: ProjectSnapshot) =>
      s.ruleset.projectVersion ===
      base + Object.values(s.ruleset.flags).reduce((n, f) => n + f.version - 1, 0);

    const slowSnapshots = new PostgresSnapshotSource(new PostgresRepository(slowPool(db.pool, 5)));
    let writing = true;
    const writes = Promise.all(
      targets.map((key) => flags.update(projectId, key, 1, { description: 'changed' })),
    ).finally(() => {
      writing = false;
    });
    const seen: ProjectSnapshot[] = [];
    while (writing) seen.push((await slowSnapshots.load(projectId))!);
    await writes;

    // The race must actually have happened: some snapshots saw a partial set of writes.
    const partial = seen.filter((s) => s.ruleset.projectVersion > base);
    expect(partial.length).toBeGreaterThan(0);
    expect(seen.filter((s) => !consistent(s))).toEqual([]);
  });
});
