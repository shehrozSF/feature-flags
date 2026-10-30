import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/domain/errors';
import type { NewFlag } from '../src/domain/ports';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
});
afterAll(() => db.drop());

// Each test makes its own project, so tests never see each other's data.
const newProject = async () => (await repo.createProject({ name: 'p', expiresAt: null })).id;

const flag = (key = 'banner'): NewFlag => ({
  key,
  name: 'Banner',
  description: '',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [
    {
      id: 'r1',
      conditions: [{ attribute: 'country', op: 'eq', values: ['PK'] }],
      serve: { variant: 'on' },
    },
  ],
  defaultServe: {
    rollout: [
      { variant: 'on', weight: 2500 },
      { variant: 'off', weight: 7500 },
    ],
  },
  salt: 'salt-1',
});

describe('PostgresRepository', () => {
  it('inserts and reads a flag', async () => {
    const p = await newProject();
    const inserted = await repo.insertFlag(p, flag());
    expect(inserted).toMatchObject({ ...flag(), version: 1, archivedAt: null });
    expect(await repo.getFlag(p, 'banner')).toEqual(inserted);
  });

  it('duplicate key throws ConflictError', async () => {
    const p = await newProject();
    await repo.insertFlag(p, flag());
    await expect(repo.insertFlag(p, flag())).rejects.toBeInstanceOf(ConflictError);
  });

  it('updateFlag with the right version increments it', async () => {
    const p = await newProject();
    await repo.insertFlag(p, flag());
    const updated = await repo.updateFlag(p, 'banner', 1, { enabled: false });
    expect(updated).toMatchObject({ enabled: false, version: 2 });
  });

  it('updateFlag with a stale version returns null and changes nothing', async () => {
    const p = await newProject();
    await repo.insertFlag(p, flag());
    await repo.updateFlag(p, 'banner', 1, { enabled: false });
    expect(await repo.updateFlag(p, 'banner', 1, { name: 'stale' })).toBeNull();
    expect(await repo.getFlag(p, 'banner')).toMatchObject({ name: 'Banner', version: 2 });
  });

  // The core optimistic-concurrency guarantee: two editors who both loaded
  // version 1 can't both save. Each update runs on its own pool connection.
  it('concurrent updates with the same version: one wins, one conflicts', async () => {
    const p = await newProject();
    await repo.insertFlag(p, flag());
    const results = await Promise.all([
      repo.updateFlag(p, 'banner', 1, { name: 'Alice' }),
      repo.updateFlag(p, 'banner', 1, { name: 'Bob' }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await repo.getFlag(p, 'banner')).toMatchObject({ version: 2 });
  });

  it('archived flags are hidden from listFlags but returned by getFlag', async () => {
    const p = await newProject();
    await repo.insertFlag(p, flag('a'));
    await repo.insertFlag(p, flag('b'));
    expect(await repo.archiveFlag(p, 'a', 1)).toMatchObject({ version: 2 });
    expect((await repo.listFlags(p)).map((f) => f.key)).toEqual(['b']);
    expect((await repo.getFlag(p, 'a'))?.archivedAt).not.toBeNull();
    expect(await repo.countActiveFlags(p)).toBe(1);
  });

  it('withTransaction rolls back on error', async () => {
    const p = await newProject();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.insertFlag(p, flag());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await repo.getFlag(p, 'banner')).toBeNull();
  });

  it('bumpProjectVersion increments and returns the new version', async () => {
    const p = await newProject();
    expect(await repo.projectVersion(p)).toBe(1);
    expect(await repo.bumpProjectVersion(p)).toBe(2);
    expect(await repo.projectVersion(p)).toBe(2);
  });

  it('projectVersion of an unknown project is null', async () => {
    expect(await repo.projectVersion('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('findKey returns the stored kind and revokedAt', async () => {
    const p = await newProject();
    const hash = new Uint8Array([1, 2, 3]);
    await repo.insertKey(p, { kind: 'server', secretHash: hash, prefix: 'ff_server_x' });
    expect(await repo.findKey(p, hash)).toEqual({ kind: 'server', revokedAt: null });
    expect(await repo.findKey(p, new Uint8Array([9]))).toBeNull();
  });
});
