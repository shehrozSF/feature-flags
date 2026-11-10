import { ROUTES } from '@ff/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import type { SnapshotSource } from '../src/domain/ports';
import {
  PostgresKeyVerifier,
  PostgresRulesetSource,
  PostgresSnapshotSource,
} from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import type { HubClient } from '../src/hub/hub-client';
import { HubSession } from '../src/hub/hub-session';
import { createNotifier, type Notify } from '../src/hub/notifier';
import { memoryHubs } from '../src/hub/memory-hub';
import { createApp } from '../src/http/app';
import { hashSecret, parseKey, toHex } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { expectContract, matchRoute, uncoveredResponses } from './helpers/contract';
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

// Every response goes through the contract check before the test sees it, so
// any test that hits a registered route also verifies the response shape.
async function call(
  method: string,
  path: string,
  options: {
    key?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    /** Another app instance (e.g. with failing dependencies); defaults to the shared one. */
    app?: ReturnType<typeof createApp>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  let body: string | undefined = options.rawBody;
  if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  const res = await (options.app ?? app).request(path, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const route = matchRoute(method, path);
  if (route) await expectContract(route, res);
  return res;
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
  const body = (await res.json()) as {
    status: number;
    errors?: { path: string; message: string }[];
  };
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

describe('every protected route', () => {
  // Built from the shared registry, so a new route is covered automatically.
  const protectedRoutes = ROUTES.filter((r) => r.auth !== 'none');
  const wrongKind = { admin: 'client', server: 'admin', client: 'server' } as const;

  it.each(protectedRoutes.map((r) => ({ id: r.id, route: r })))(
    '$id: 401 without a key, 403 with the wrong kind',
    async ({ route }) => {
      const { keys } = await sandbox();
      const path = route.path.replace('{key}', 'promo-banner');
      const body = route.body ? {} : undefined;
      await expectProblem(await call(route.method, path, { body }), 401);
      const kind = wrongKind[route.auth as keyof typeof wrongKind];
      await expectProblem(await call(route.method, path, { key: keys[kind], body }), 403);
    },
  );
});

describe('review fixes', () => {
  // Review #1: versions larger than a Postgres integer used to cause a 500.
  it('a huge If-Match version is a conflict, not a server error', async () => {
    const { keys } = await sandbox();
    const opts = { key: keys.admin, headers: { 'if-match': '"9999999999"' } };
    await expectProblem(
      await call('PATCH', '/v1/flags/promo-banner', { ...opts, body: { enabled: false } }),
      409,
    );
    await expectProblem(await call('DELETE', '/v1/flags/promo-banner', opts), 409);
  });

  // Review #2: 20,000 nested arrays fit in 64 KB but overflowed the stack in
  // the recursive JSON schema (→ 500), and anyone with a free sandbox key could send it.
  it('deeply nested JSON gets 422, not a stack overflow', async () => {
    const { keys } = await sandbox();
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const rawBody = `{"key":"deep","name":"Deep","variants":[{"key":"on","value":${deep}}],"offVariant":"on","defaultServe":{"variant":"on"}}`;
    const body = await expectProblem(
      await call('POST', '/v1/flags', { key: keys.admin, rawBody }),
      422,
    );
    expect(body.errors?.[0]?.message).toContain('nested');
  });
});

describe('remaining error responses', () => {
  const big = 'x'.repeat(70_000);

  it('create with an existing key gets 409', async () => {
    const { keys } = await sandbox();
    await expectProblem(
      await call('POST', '/v1/flags', {
        key: keys.admin,
        body: { ...newFlag, key: 'promo-banner' },
      }),
      409,
    );
  });

  it('update: bad JSON 400, unknown flag 404, too big 413, invalid 422', async () => {
    const { keys } = await sandbox();
    const opts = { key: keys.admin, headers: { 'if-match': '"1"' } };
    await expectProblem(
      await call('PATCH', '/v1/flags/promo-banner', { ...opts, rawBody: '{' }),
      400,
    );
    await expectProblem(
      await call('PATCH', '/v1/flags/nope', { ...opts, body: { enabled: true } }),
      404,
    );
    await expectProblem(
      await call('PATCH', '/v1/flags/promo-banner', { ...opts, body: { description: big } }),
      413,
    );
    await expectProblem(
      await call('PATCH', '/v1/flags/promo-banner', { ...opts, body: { offVariant: 'nope' } }),
      422,
    );
  });

  it('archive: without If-Match 428, stale version 409', async () => {
    const { keys } = await sandbox();
    await expectProblem(await call('DELETE', '/v1/flags/promo-banner', { key: keys.admin }), 428);
    await expectProblem(
      await call('DELETE', '/v1/flags/promo-banner', {
        key: keys.admin,
        headers: { 'if-match': '"7"' },
      }),
      409,
    );
  });

  it('evaluate: bad JSON 400, too big 413', async () => {
    const { keys } = await sandbox();
    await expectProblem(
      await call('POST', '/v1/client/evaluate', { key: keys.client, rawBody: '{' }),
      400,
    );
    await expectProblem(
      await call('POST', '/v1/client/evaluate', {
        key: keys.client,
        body: { context: { note: big } },
      }),
      413,
    );
  });
});

// Runs last (Vitest runs a file's tests in order): every response the
// registry declares must have been produced and checked by some test above.
const hashOf = async (raw: string) => toHex(await hashSecret(parseKey(raw)!.secret));

describe('pushing changes to the hub', () => {
  // The same app, plus notify: after every committed write, load a fresh snapshot
  // and push it to the project's hub (ADR 0029).
  const appWith = (notify: Notify) => {
    const repo = new PostgresRepository(db.pool);
    return createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo),
      rulesets: new PostgresRulesetSource(repo),
      keys: new PostgresKeyVerifier(repo),
      notify,
      version: 'test',
    });
  };

  it('a flag change reaches the hub', async () => {
    const hubs = memoryHubs();
    const snapshots: SnapshotSource = new PostgresSnapshotSource(new PostgresRepository(db.pool));
    const app = appWith(createNotifier({ hub: hubs, snapshots }));
    const { projectId, keys } = await sandbox();

    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
      app,
    });
    expect(res.status).toBe(200);

    // Read the hub directly: it already holds version 2, nobody had to load it.
    const read = await hubs(projectId).read('client', await hashOf(keys.client));
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.ruleset.projectVersion).toBe(2);
      expect(read.ruleset.flags['promo-banner']!.enabled).toBe(false);
    }
  });

  it('a successful update has no propagation header', async () => {
    const app = appWith(() => Promise.resolve('ok'));
    const { keys } = await sandbox();
    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
      app,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-propagation')).toBeNull();
  });

  it('a failed hub update still saves, marked delayed', async () => {
    const update = vi.fn(() => Promise.reject(new Error('hub unreachable')));
    const broken: HubClient = {
      read: () => Promise.resolve({ status: 'cold' }),
      update,
      clear: () => Promise.resolve(),
    };
    const snapshots = new PostgresSnapshotSource(new PostgresRepository(db.pool));
    const app = appWith(createNotifier({ hub: () => broken, snapshots, delayMs: 1 }));
    const { keys } = await sandbox();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
      app,
    });
    errors.mockRestore();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-propagation')).toBe('delayed');
    expect(update).toHaveBeenCalledTimes(3);
    // The write is committed regardless.
    const saved = await call('GET', '/v1/flags/promo-banner', { key: keys.admin });
    expect(((await saved.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it('a hub that never answers counts as a failed attempt', async () => {
    const update = vi.fn(() => new Promise<never>(() => undefined));
    const hung: HubClient = {
      read: () => Promise.resolve({ status: 'cold' }),
      update,
      clear: () => Promise.resolve(),
    };
    const snapshots = new PostgresSnapshotSource(new PostgresRepository(db.pool));
    const app = appWith(createNotifier({ hub: () => hung, snapshots, delayMs: 1, timeoutMs: 20 }));
    const { keys } = await sandbox();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
      app,
    });
    errors.mockRestore();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-propagation')).toBe('delayed');
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('creates and archives notify the hub too', async () => {
    const notify = vi.fn<Notify>(() => Promise.resolve('delayed'));
    const app = appWith(notify);
    const { projectId, keys } = await sandbox();

    const created = await call('POST', '/v1/flags', { key: keys.admin, body: newFlag, app });
    expect(created.headers.get('x-propagation')).toBe('delayed');
    const archived = await call('DELETE', '/v1/flags/checkout', {
      key: keys.admin,
      headers: { 'if-match': '"1"' },
      app,
    });
    expect(archived.headers.get('x-propagation')).toBe('delayed');
    expect(notify.mock.calls).toEqual([[projectId], [projectId]]);
  });

  it('a rejected write notifies nobody', async () => {
    const notify = vi.fn<Notify>(() => Promise.resolve('ok'));
    const app = appWith(notify);
    const { keys } = await sandbox();
    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"9"' },
      app,
    });
    expect(res.status).toBe(409);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a project deleted while a write is in flight', () => {
  // Forces the race for real: the write commits, then the project is deleted
  // (as sandbox expiry will do) right before the notifier loads the snapshot.
  const racing = () => {
    const repo = new PostgresRepository(db.pool);
    const real = new PostgresSnapshotSource(repo);
    const snapshots: SnapshotSource = {
      load: async (projectId) => {
        await db.pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
        return real.load(projectId);
      },
    };
    const hubs = memoryHubs();
    const app = createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo),
      rulesets: new PostgresRulesetSource(repo),
      keys: new PostgresKeyVerifier(repo),
      notify: createNotifier({ hub: hubs, snapshots }),
      version: 'test',
    });
    return { app, hubs };
  };

  it('the writer is told the project is gone, and its hub forgets it', async () => {
    const { app, hubs } = racing();
    const { projectId, keys } = await sandbox();
    // The hub was serving this project before the deletion.
    await hubs(projectId).update(
      (await new PostgresSnapshotSource(new PostgresRepository(db.pool)).load(projectId))!,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await call('PATCH', '/v1/flags/promo-banner', {
      key: keys.admin,
      body: { enabled: false },
      headers: { 'if-match': '"1"' },
      app,
    });

    expect(((await expectProblem(res, 404)) as { detail?: string }).detail).toBe(
      'project no longer exists',
    );
    // SDK keys of a deleted project must stop working: the hub holds nothing now.
    expect(await hubs(projectId).read('client', await hashOf(keys.client))).toEqual({
      status: 'cold',
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain(projectId); // and the system logs it
    warn.mockRestore();
  });

  it('creating a flag in a project deleted meanwhile → 404', async () => {
    const { app } = racing();
    const { keys } = await sandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await call('POST', '/v1/flags', { key: keys.admin, body: newFlag, app });
    warn.mockRestore();
    await expectProblem(res, 404);
  });
});

describe('database unreachable while the hub is cold', () => {
  // SDK reads come from the hub; with nothing cached and Postgres down there is
  // nothing to serve, so the API says "try again shortly" instead of 500.
  const down = () => {
    const session = new HubSession({
      hub: memoryHubs(),
      snapshots: { load: () => Promise.reject(new Error('connect ECONNREFUSED')) },
      postgresKeys: { verify: () => Promise.resolve(false) },
      waitUntil: () => undefined,
    });
    const repo = new PostgresRepository(db.pool);
    return createApp({
      flags: new FlagService(repo),
      sandboxes: new SandboxService(repo),
      rulesets: session,
      keys: session,
      version: 'test',
    });
  };
  const key = (kind: string) => `ff_${kind}_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'A'.repeat(43)}`;

  it('SDK rules → 503 with Retry-After', async () => {
    const res = await call('GET', '/v1/sdk/rules', { key: key('server'), app: down() });
    expect(res.headers.get('retry-after')).toBe('5');
    await expectProblem(res, 503);
  });

  it('client evaluate → 503 with Retry-After', async () => {
    const res = await call('POST', '/v1/client/evaluate', {
      key: key('client'),
      body: { context: { userId: 'u1' } },
      app: down(),
    });
    expect(res.headers.get('retry-after')).toBe('5');
    await expectProblem(res, 503);
  });
});

describe('contract coverage', () => {
  it('every declared route/status is exercised by at least one test', () => {
    expect(uncoveredResponses()).toEqual([]);
  });
});

describe('unexpected errors', () => {
  // Uses stub dependencies and calls app.request directly: a 500 is never part
  // of the contract, so this deliberately bypasses the contract check.
  it('become a generic 500 problem without leaking internals', async () => {
    const boom = new Error('connection to 10.0.0.5:5432 refused (password=hunter2)');
    const broken = createApp({
      flags: { list: () => Promise.reject(boom) } as unknown as FlagService,
      sandboxes: {} as SandboxService,
      rulesets: { getRuleset: () => Promise.resolve(null) },
      keys: { verify: () => Promise.resolve(true) },
      version: 'test',
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const key = `ff_admin_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'A'.repeat(43)}`;

    const res = await broken.request('/v1/flags', { headers: { authorization: `Bearer ${key}` } });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const text = await res.text();
    expect(text).toContain('something went wrong');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('10.0.0.5');
    expect(errors).toHaveBeenCalledWith(boom); // logged on the server instead
    errors.mockRestore();
  });
});
