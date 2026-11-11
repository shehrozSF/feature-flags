import { LIMITS } from '@ff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/domain/errors';
import { FlagService } from '../src/domain/flags';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// The per-project size cap: everything SDKs download for a project (variants,
// rules, default serve of every active flag) stays under a limit, so a snapshot
// can't outgrow Durable Object storage or make SDK downloads heavy. Each flag is
// already capped (32 KB of rules), but 50 of them add up. Tests use a small cap.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let repo: PostgresRepository;
beforeAll(async () => {
  db = await createTestDatabase();
  repo = new PostgresRepository(db.pool);
});
afterAll(() => db.drop());

const CAP = 4_000;
const newProject = async () => (await repo.createProject({ name: 'p', expiresAt: null })).id;
/** A flag whose variants carry `bytes` of text, so its size is easy to control. */
const flag = (key: string, bytes: number) => ({
  key,
  name: key,
  variants: [
    { key: 'on', value: 'x'.repeat(bytes) },
    { key: 'off', value: '' },
  ],
  offVariant: 'off',
  defaultServe: { variant: 'on' },
});
const sizeError = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).errors[0]!.message).toMatch(/at most 4000 bytes/);
};

describe('the per-project ruleset size cap', () => {
  it('defaults to 1 MB', () => {
    expect(LIMITS.rulesetBytesPerProject).toBe(1024 * 1024);
  });

  it('a create that takes the project over the cap is a 422, and nothing is saved', async () => {
    const flags = new FlagService(repo, { rulesetBytes: CAP });
    const projectId = await newProject();
    await flags.create(projectId, flag('a', 2_500));

    await sizeError(flags.create(projectId, flag('b', 2_500)));
    expect((await flags.list(projectId)).map((f) => f.key)).toEqual(['a']);
    expect(await repo.projectVersion(projectId)).toBe(2); // only the first create bumped it
  });

  it('an update that grows past the cap is a 422 and changes nothing', async () => {
    const flags = new FlagService(repo, { rulesetBytes: CAP });
    const projectId = await newProject();
    const a = await flags.create(projectId, flag('a', 1_000));

    await sizeError(
      flags.update(projectId, 'a', a.version, { variants: flag('a', 5_000).variants }),
    );
    expect((await flags.get(projectId, 'a')).version).toBe(a.version);
  });

  it('an update that shrinks a flag is allowed, even while still over the cap', async () => {
    // A project over the cap (e.g. the cap was lowered) must be able to get back under it.
    const projectId = await newProject();
    const roomy = new FlagService(repo, { rulesetBytes: 100_000 });
    const a = await roomy.create(projectId, flag('a', 6_000));
    const tight = new FlagService(repo, { rulesetBytes: CAP });

    const shrunk = await tight.update(projectId, 'a', a.version, {
      variants: flag('a', 5_000).variants,
    });
    expect(shrunk.version).toBe(a.version + 1);
  });

  it("archived flags don't count", async () => {
    const flags = new FlagService(repo, { rulesetBytes: CAP });
    const projectId = await newProject();
    const a = await flags.create(projectId, flag('a', 2_500));
    await flags.archive(projectId, 'a', a.version);

    await expect(flags.create(projectId, flag('b', 2_500))).resolves.toMatchObject({ key: 'b' });
  });
});
