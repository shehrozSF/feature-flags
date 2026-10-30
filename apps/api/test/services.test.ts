import { evaluateAll } from '@ff/eval-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  PreconditionRequiredError,
  ValidationError,
} from '../src/domain/errors';
import { FlagService } from '../src/domain/flags';
import type { Repository } from '../src/domain/ports';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { parseKey } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;
let flags: FlagService;
let sandboxes: SandboxService;
let rulesets: PostgresRulesetSource;
let keys: PostgresKeyVerifier;

beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
  flags = new FlagService(repo);
  sandboxes = new SandboxService(repo);
  rulesets = new PostgresRulesetSource(repo);
  keys = new PostgresKeyVerifier(repo);
});
afterAll(() => db.drop());

const input = (key = 'checkout') => ({
  key,
  name: 'Checkout',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  defaultServe: { variant: 'on' },
});

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
};

describe('SandboxService', () => {
  it('creates 4 seeded flags and 3 working keys', async () => {
    const { projectId, keys: k } = await sandboxes.create();
    for (const [kind, raw] of Object.entries(k)) {
      const parsed = parseKey(raw);
      expect(parsed).toMatchObject({ kind, projectId });
      expect(await keys.verify(parsed!)).toBe(true);
    }
    expect((await flags.list(projectId)).map((f) => f.key)).toEqual([
      'cta-color',
      'new-pricing',
      'pk-local-payments',
      'promo-banner',
    ]);
  });

  it('seeded flags evaluate as the spec describes', async () => {
    const { projectId } = await sandboxes.create();
    const ruleset = (await rulesets.getRuleset(projectId))!;
    const pk = evaluateAll(ruleset, { userId: 'u1', country: 'PK', plan: 'pro' });
    expect(pk['promo-banner']).toMatchObject({ variant: 'on' });
    expect(pk['pk-local-payments']).toMatchObject({ variant: 'on', reason: 'RULE_MATCH' });
    expect(pk['new-pricing']).toMatchObject({ variant: 'on', reason: 'RULE_MATCH' });
    expect(['blue', 'green', 'red']).toContain(pk['cta-color']?.variant);
    const us = evaluateAll(ruleset, { userId: 'u1', country: 'US' });
    expect(us['pk-local-payments']).toMatchObject({ variant: 'off', reason: 'DEFAULT' });
  });
});

describe('FlagService', () => {
  const project = async () => (await sandboxes.create()).projectId;

  it('rejects an invalid flag with field errors', async () => {
    const e = await rejection(flags.create(await project(), { ...input(), offVariant: 'nope' }));
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).errors.map((x) => x.path)).toContain('offVariant');
  });

  it('rejects the 51st flag', async () => {
    const p = await project(); // 4 seeded
    for (let i = 0; i < 46; i++) await flags.create(p, input(`f${i}`));
    const e = await rejection(flags.create(p, input('one-too-many')));
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).errors[0]!.message).toContain('50-flag limit');
  });

  it('creating a flag with an archived key conflicts', async () => {
    const p = await project();
    await flags.create(p, input());
    await flags.archive(p, 'checkout', 1);
    const e = await rejection(flags.create(p, input()));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).message).toBe('flag key is archived');
  });

  it('update without a version needs a precondition', async () => {
    const p = await project();
    await flags.create(p, input());
    expect(await rejection(flags.update(p, 'checkout', null, { enabled: true }))).toBeInstanceOf(
      PreconditionRequiredError,
    );
  });

  it('update with a stale version conflicts and carries the current flag', async () => {
    const p = await project();
    await flags.create(p, input());
    await flags.update(p, 'checkout', 1, { enabled: true });
    const e = await rejection(flags.update(p, 'checkout', 1, { name: 'stale' }));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).current?.version).toBe(2);
  });

  it('update validates the merged flag', async () => {
    const p = await project();
    await flags.create(p, input());
    const e = await rejection(flags.update(p, 'checkout', 1, { offVariant: 'nope' }));
    expect((e as ValidationError).errors.map((x) => x.path)).toContain('offVariant');
  });

  it('missing and archived flags are not found', async () => {
    const p = await project();
    expect(await rejection(flags.get(p, 'nope'))).toBeInstanceOf(NotFoundError);
    await flags.create(p, input());
    await flags.archive(p, 'checkout', 1);
    expect(await rejection(flags.get(p, 'checkout'))).toBeInstanceOf(NotFoundError);
    expect(await rejection(flags.update(p, 'checkout', 2, { enabled: true }))).toBeInstanceOf(
      NotFoundError,
    );
  });

  it('every change bumps the project version', async () => {
    const p = await project();
    const version = async () => (await rulesets.getRuleset(p))!.projectVersion;
    expect(await version()).toBe(1);
    await flags.create(p, input());
    expect(await version()).toBe(2);
    await flags.update(p, 'checkout', 1, { enabled: true });
    expect(await version()).toBe(3);
    await flags.archive(p, 'checkout', 2);
    expect(await version()).toBe(4);
  });

  it('the ruleset excludes archived flags', async () => {
    const p = await project();
    await flags.archive(p, 'promo-banner', 1);
    expect(Object.keys((await rulesets.getRuleset(p))!.flags)).not.toContain('promo-banner');
  });

  it('the ruleset of an unknown project is null', async () => {
    expect(await rulesets.getRuleset('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('PostgresKeyVerifier', () => {
  it('revoked key is rejected', async () => {
    const { projectId, keys: k } = await sandboxes.create();
    await db.pool.query(`UPDATE api_keys SET revoked_at = now() WHERE project_id = $1`, [
      projectId,
    ]);
    expect(await keys.verify(parseKey(k.admin)!)).toBe(false);
  });

  it('a key claiming the wrong kind is rejected', async () => {
    const { keys: k } = await sandboxes.create();
    const client = parseKey(k.client)!;
    expect(await keys.verify({ ...client, kind: 'admin' })).toBe(false);
  });
});

describe('the 50-flag limit under concurrency', () => {
  // Review #3. A race only shows up if the bad interleaving actually happens,
  // so this forces it: counting flags takes 100 ms, giving every parallel
  // create time to count before any of them inserts.
  function slowCounts(inner: Repository): Repository {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'countActiveFlags') {
          return async (projectId: string) => {
            const n = await target.countActiveFlags(projectId);
            await new Promise((resolve) => setTimeout(resolve, 100));
            return n;
          };
        }
        if (prop === 'withTransaction') {
          return <T>(fn: (tx: Repository) => Promise<T>) =>
            target.withTransaction((tx) => fn(slowCounts(tx)));
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  it('parallel creates at 49 flags: exactly one succeeds', async () => {
    const p = (await sandboxes.create()).projectId; // 4 seeded
    for (let i = 0; i < 45; i++) await flags.create(p, input(`f${i}`));
    const racing = new FlagService(slowCounts(repo));
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => racing.create(p, input(`race${i}`))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await repo.countActiveFlags(p)).toBe(50);
  });
});
