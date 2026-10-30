import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp } from '../src/http/app';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// The real app on a real database: requests go through routing, auth,
// validation, services and SQL exactly as in production — only the network
// is skipped (app.request calls the handler directly).
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await createTestDatabase();
  const repo = new PostgresRepository(db.pool);
  app = createApp({
    flags: new FlagService(repo),
    sandboxes: new SandboxService(repo),
    rulesets: new PostgresRulesetSource(repo),
    keys: new PostgresKeyVerifier(repo),
    version: 'test',
  });
});
afterAll(() => db.drop());

type Keys = { admin: string; server: string; client: string };

function call(
  method: string,
  path: string,
  options: {
    key?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  return app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
}

async function sandbox(): Promise<{ projectId: string; keys: Keys }> {
  const res = await call('POST', '/v1/sandboxes');
  expect(res.status).toBe(201);
  return (await res.json()) as { projectId: string; keys: Keys };
}

const newFlag = {
  key: 'checkout',
  name: 'Checkout',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  defaultServe: { variant: 'on' },
};

const expectProblem = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const body = (await res.json()) as { status: number; errors?: { path: string }[] };
  expect(body.status).toBe(status);
  return body;
};

describe('sandboxes', () => {
  it('creates a sandbox and returns three keys', async () => {
    const { keys } = await sandbox();
    expect(Object.keys(keys).sort()).toEqual(['admin', 'client', 'server']);
  });
});

describe('flags', () => {
  it('lists the seeded flags', async () => {
    const { keys } = await sandbox();
    const res = await call('GET', '/v1/flags', { key: keys.admin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: { key: string }[] };
    expect(body.flags).toHaveLength(4);
  });

  it('full lifecycle: create, read, update, conflict, archive', async () => {
    const { keys } = await sandbox();
    const admin = { key: keys.admin };

    const created = await call('POST', '/v1/flags', { ...admin, body: newFlag });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"1"');

    const read = await call('GET', '/v1/flags/checkout', admin);
    expect(read.status).toBe(200);
    expect(read.headers.get('etag')).toBe('"1"');

    const updated = await call('PATCH', '/v1/flags/checkout', {
      ...admin,
      body: { enabled: true },
      headers: { 'if-match': '"1"' },
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe('"2"');

    const stale = await call('PATCH', '/v1/flags/checkout', {
      ...admin,
      body: { name: 'stale' },
      headers: { 'if-match': '1' }, // bare versions are accepted too
    });
    const conflict = (await expectProblem(stale, 409)) as unknown as {
      current: { version: number };
    };
    expect(conflict.current.version).toBe(2);

    const archived = await call('DELETE', '/v1/flags/checkout', {
      ...admin,
      headers: { 'if-match': '"2"' },
    });
    expect(archived.status).toBe(204);
    await expectProblem(await call('GET', '/v1/flags/checkout', admin), 404);
  });

  it('patch without If-Match gets 428', async () => {
    const { keys } = await sandbox();
    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
    });
    await expectProblem(res, 428);
  });

  it('invalid flags get 422 with field errors', async () => {
    const { keys } = await sandbox();
    const res = await call('POST', '/v1/flags', {
      key: keys.admin,
      body: { ...newFlag, offVariant: 'nope' },
    });
    const body = await expectProblem(res, 422);
    expect(body.errors?.map((e) => e.path)).toContain('offVariant');
  });

  it('admin key cannot touch another project’s flags', async () => {
    const a = await sandbox();
    const b = await sandbox();
    await call('POST', '/v1/flags', { key: b.keys.admin, body: { ...newFlag, key: 'only-in-b' } });

    // A's key always acts on A's own `promo-banner`, never B's.
    await call('PATCH', '/v1/flags/promo-banner', {
      key: a.keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
    });
    const bBanner = await call('GET', '/v1/flags/promo-banner', { key: b.keys.admin });
    expect(((await bBanner.json()) as { version: number }).version).toBe(1);

    // A flag that exists only in B is invisible to A.
    await expectProblem(await call('GET', '/v1/flags/only-in-b', { key: a.keys.admin }), 404);
    await expectProblem(
      await call('DELETE', '/v1/flags/only-in-b', {
        key: a.keys.admin,
        headers: { 'if-match': '"1"' },
      }),
      404,
    );
  });
});

describe('sdk rules', () => {
  it('returns the ruleset with an ETag, then 304 until something changes', async () => {
    const { keys } = await sandbox();
    const first = await call('GET', '/v1/sdk/rules', { key: keys.server });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe('"1"');
    expect(((await first.json()) as { flags: object }).flags).toHaveProperty('promo-banner');

    const unchanged = await call('GET', '/v1/sdk/rules', {
      key: keys.server,
      headers: { 'if-none-match': etag },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');

    await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
    });
    const changed = await call('GET', '/v1/sdk/rules', {
      key: keys.server,
      headers: { 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).toBe('"2"');
  });
});

describe('client evaluate', () => {
  it('returns every flag for the context', async () => {
    const { keys } = await sandbox();
    const res = await call('POST', '/v1/client/evaluate', {
      key: keys.client,
      body: { context: { userId: 'u1', country: 'PK' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      flags: Record<string, { variant: string }>;
    };
    expect(body.version).toBe(1);
    expect(body.flags['pk-local-payments']?.variant).toBe('on');
  });

  it('missing context gets 422 at path "context"', async () => {
    const { keys } = await sandbox();
    const res = await call('POST', '/v1/client/evaluate', { key: keys.client, body: {} });
    const body = await expectProblem(res, 422);
    expect(body.errors?.map((e) => e.path)).toContain('context');
  });
});

describe('authentication', () => {
  it('wrong key kind gets 403', async () => {
    const { keys } = await sandbox();
    await expectProblem(await call('GET', '/v1/flags', { key: keys.client }), 403);
    await expectProblem(await call('GET', '/v1/sdk/rules', { key: keys.admin }), 403);
    await expectProblem(
      await call('POST', '/v1/client/evaluate', { key: keys.server, body: { context: {} } }),
      403,
    );
  });

  const uuid = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
  it.each([
    { name: 'no header', headers: {} },
    { name: 'empty bearer', headers: { authorization: 'Bearer' } },
    {
      name: 'project id not a UUID',
      headers: { authorization: `Bearer ff_admin_not-a-uuid_${'A'.repeat(43)}` },
    },
    {
      name: 'unknown secret',
      headers: { authorization: `Bearer ff_admin_${uuid}_${'A'.repeat(43)}` },
    },
    { name: 'basic auth', headers: { authorization: 'Basic abc' } },
  ])('malformed keys get 401, never 500: $name', async ({ headers }) => {
    await expectProblem(await call('GET', '/v1/flags', { headers }), 401);
  });
});

describe('bad requests', () => {
  it('invalid JSON body gets 400 problem+json', async () => {
    const { keys } = await sandbox();
    await expectProblem(
      await call('POST', '/v1/flags', { key: keys.admin, rawBody: '{not json' }),
      400,
    );
  });

  it('an array body gets 422', async () => {
    const { keys } = await sandbox();
    await expectProblem(await call('POST', '/v1/flags', { key: keys.admin, body: [newFlag] }), 422);
  });

  it('an oversized body gets 413', async () => {
    const { keys } = await sandbox();
    const res = await call('POST', '/v1/flags', {
      key: keys.admin,
      body: { ...newFlag, description: 'x'.repeat(70_000) },
    });
    await expectProblem(res, 413);
  });

  it('an unknown route gets 404 problem+json', async () => {
    await expectProblem(await call('GET', '/v1/nope'), 404);
  });
});

describe('health', () => {
  it('returns ok and the version', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'test' });
  });
});
