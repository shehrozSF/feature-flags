import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresSnapshotSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { createApp, type AppDeps } from '../src/http/app';
import { HubSession } from '../src/hub/hub-session';
import { memoryHubs } from '../src/hub/memory-hub';
import { createNotifier } from '../src/hub/notifier';
import { hashSecret, parseKey, toHex } from '../src/keys';
import { PostgresRepository } from '../src/repo/postgres';
import { createTestDatabase } from './helpers/db';

// Spec §9.3: never log keys or evaluation contexts (they may hold PII).
// A "canary" test: send distinctive values through every route and error path,
// capture everything written to the console, and check none of them shows up.
// It can't prove every future log line is safe, but any route that starts
// leaking one of these values fails here.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let deps: AppDeps;
beforeAll(async () => {
  db = await createTestDatabase();
  const repo = new PostgresRepository(db.pool);
  const hub = memoryHubs();
  const snapshots = new PostgresSnapshotSource(repo);
  const session = new HubSession({
    hub,
    snapshots,
    postgresKeys: new PostgresKeyVerifier(repo),
    waitUntil: () => undefined,
  });
  deps = {
    flags: new FlagService(repo),
    sandboxes: new SandboxService(repo),
    rulesets: session,
    keys: session,
    notify: createNotifier({ hub, snapshots }),
    version: 'test',
  };
});
afterAll(() => db.drop());

const CANARY = {
  ip: '203.0.113.77',
  ray: 'canary-ray-7f3a', // not the cf-ray format: must not be trusted as a request id
  agent: 'canary-agent-7f3a',
  userId: 'canary-user-7f3a',
  email: 'canary-7f3a@example.com',
  secret: `Canary7f3a${'x'.repeat(33)}`,
  message: 'canary-message-7f3a',
};
const headers = {
  'cf-connecting-ip': CANARY.ip,
  'cf-ray': CANARY.ray,
  'user-agent': CANARY.agent,
};

function captureConsole() {
  const written: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(
        args.map((a) => (a instanceof Error ? `${a.stack}` : JSON.stringify(a))).join(' '),
      );
    });
  }
  return written;
}

describe('canary values never reach a log line', () => {
  it('across every route, success and error', async () => {
    const written = captureConsole();
    const app = createApp(deps);
    const call = (method: string, path: string, key?: string, body?: unknown, extra = {}) =>
      app.request(path, {
        method,
        headers: {
          ...headers,
          ...extra,
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      });

    const created = await call('POST', '/v1/sandboxes');
    const { keys } = (await created.json()) as {
      keys: Record<'admin' | 'server' | 'client', string>;
    };
    const projectId = parseKey(keys.client)!.projectId;
    const context = { userId: CANARY.userId, email: CANARY.email, country: 'PK' };
    const flag = {
      key: 'checkout',
      name: 'Checkout',
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      offVariant: 'off',
      defaultServe: { variant: 'on' },
    };

    const statuses = [
      (await call('GET', '/v1/flags', keys.admin)).status,
      (await call('POST', '/v1/flags', keys.admin, flag)).status,
      (await call('GET', '/v1/flags/checkout', keys.admin)).status,
      (await call('PATCH', '/v1/flags/checkout', keys.admin, { name: 'B' }, { 'if-match': '"1"' }))
        .status,
      (await call('PATCH', '/v1/flags/checkout', keys.admin, { name: 'C' }, { 'if-match': '"1"' }))
        .status, // stale: 409
      (await call('DELETE', '/v1/flags/checkout', keys.admin, undefined, { 'if-match': '"2"' }))
        .status,
      (await call('GET', '/v1/sdk/rules', keys.server)).status,
      (await call('POST', '/v1/client/evaluate', keys.client, { context })).status,
      (await call('POST', '/v1/client/evaluate', keys.admin, { context })).status, // 403
      (
        await call('POST', '/v1/client/evaluate', `ff_client_${projectId}_${CANARY.secret}`, {
          context,
        })
      ).status, // 401
      (await call('POST', '/v1/client/evaluate', keys.client, { context: CANARY.email })).status, // 422
      (await call('POST', '/v1/client/evaluate', keys.client, `{"context": ${CANARY.email}`))
        .status, // 400
    ];
    expect(statuses).toEqual([200, 201, 200, 200, 409, 204, 200, 200, 403, 401, 422, 400]);

    // Forced failures, with the canary inside the error itself.
    const boom = new Error(`${CANARY.message} ${CANARY.email}`);
    const refused = Object.assign(new Error(`connect ECONNREFUSED ${CANARY.message}`), {
      code: 'ECONNREFUSED',
    });
    const failing = (error: Error) =>
      createApp({
        ...deps,
        flags: { list: () => Promise.reject(error) } as unknown as FlagService,
      });
    const coldAndDown = new HubSession({
      hub: memoryHubs(),
      snapshots: { load: () => Promise.reject(refused) },
      postgresKeys: { verify: () => Promise.resolve(false) },
      waitUntil: () => undefined,
    });
    const sdkDown = createApp({ ...deps, rulesets: coldAndDown, keys: coldAndDown });
    const auth = { ...headers, authorization: `Bearer ${keys.admin}` };
    expect((await failing(boom).request('/v1/flags', { headers: auth })).status).toBe(500);
    expect((await failing(refused).request('/v1/flags', { headers: auth })).status).toBe(503);
    const sdk = { ...headers, authorization: `Bearer ${keys.server}` };
    expect((await sdkDown.request('/v1/sdk/rules', { headers: sdk })).status).toBe(503);

    vi.restoreAllMocks();

    // Something was logged (every request writes a line), or this test proves nothing.
    expect(written.length).toBeGreaterThanOrEqual(statuses.length + 4);
    const secrets = Object.values(keys).map((key) => parseKey(key)!.secret);
    const hashes = await Promise.all(
      [...secrets, CANARY.secret].map(async (s) => toHex(await hashSecret(s))),
    );
    const forbidden = [...Object.values(keys), ...secrets, ...hashes, ...Object.values(CANARY)];
    for (const value of forbidden) {
      const leaks = written.filter((line) => line.includes(value));
      expect(leaks, `"${value}" was logged`).toEqual([]);
    }
  });
});
