import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FlagEventSchema, type FlagEvent } from '@ff/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagService } from '../src/domain/flags';
import { PostgresKeyVerifier, PostgresRulesetSource } from '../src/domain/postgres-sources';
import { SandboxService } from '../src/domain/sandboxes';
import { WebhookService } from '../src/domain/webhooks';
import { createApp, type AppDeps } from '../src/http/app';
import { PostgresRepository } from '../src/repo/postgres';
import { postNoFollow } from '../src/web';
import { createDispatcher } from '../src/webhooks/dispatcher';
import { createTestDatabase } from './helpers/db';
import { callTool } from './helpers/mcp';

// Webhooks end to end (ADR 0039): the real app, database, dispatcher and fetch,
// delivering to a real HTTP server in this process. Background work goes through
// a waitUntil the test can await, as the Worker's ctx.waitUntil would keep it alive.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let background: Promise<unknown>[] = [];
const settle = async () => {
  await Promise.allSettled(background);
  background = [];
};

type Received = { headers: IncomingMessage['headers']; body: string };
let received: Received[] = [];
let answer = 200;
let receiver: Server;
let receiverUrl: string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = answer;
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  db = await createTestDatabase();
  const repo = new PostgresRepository(db.pool);
  deps = {
    flags: new FlagService(repo),
    sandboxes: new SandboxService(repo),
    rulesets: new PostgresRulesetSource(repo),
    keys: new PostgresKeyVerifier(repo),
    // Local http allowed, as on the Node dev server, so the receiver can be plain http.
    webhooks: new WebhookService(repo, { allowLocalHttp: true }),
    dispatch: createDispatcher({ webhooks: repo, delayMs: 0, timeoutMs: 2_000 }),
    waitUntil: (promise) => background.push(promise),
    version: 'test',
    mcpConfirmSecret: 'webhook-flow-test-secret-long-enough-0123',
  };
  app = createApp(deps);
});
afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await db.drop();
});
beforeEach(() => {
  received = [];
  answer = 200;
});

const auth = (admin: string) => ({ authorization: `Bearer ${admin}` });
const json = (admin: string) => ({ ...auth(admin), 'content-type': 'application/json' });

/** A sandbox with its webhook pointing at the receiver; returns the admin key and secret. */
async function sandboxWithWebhook() {
  const res = await app.request('/v1/sandboxes', { method: 'POST' });
  const { admin } = ((await res.json()) as { keys: { admin: string } }).keys;
  const put = await app.request('/v1/webhook', {
    method: 'PUT',
    headers: json(admin),
    body: JSON.stringify({ url: receiverUrl }),
  });
  const { secret } = (await put.json()) as { secret: string };
  return { admin, secret };
}

const FLAG = {
  key: 'checkout-v2',
  name: 'Checkout v2',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  defaultServe: {
    rollout: [
      { variant: 'on', weight: 1000 },
      { variant: 'off', weight: 9000 },
    ],
  },
};

const events = () => received.map((r) => FlagEventSchema.parse(JSON.parse(r.body)));

/** What a receiver must do: recompute the HMAC over the raw body. */
function verify({ headers, body }: Received, secret: string) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(headers['x-ff-signature']))!;
  return v1 === createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

describe('every write announces itself', () => {
  it('create, update and archive each send one signed event with before and after', async () => {
    const { admin, secret } = await sandboxWithWebhook();

    const created = await app.request('/v1/flags', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify(FLAG),
    });
    const v1 = Number(created.headers.get('etag')!.replace(/"/g, ''));
    const updated = await app.request('/v1/flags/checkout-v2', {
      method: 'PATCH',
      headers: { ...json(admin), 'if-match': `"${v1}"` },
      body: JSON.stringify({ enabled: false }),
    });
    await app.request('/v1/flags/checkout-v2', {
      method: 'DELETE',
      headers: { ...auth(admin), 'if-match': updated.headers.get('etag')! },
    });
    await settle();

    expect(events().map((e) => [e.type, e.key, e.source])).toEqual([
      ['flag.created', 'checkout-v2', 'api'],
      ['flag.updated', 'checkout-v2', 'api'],
      ['flag.archived', 'checkout-v2', 'api'],
    ]);
    const [create, update, archive] = events();
    expect(create!.before).toBeNull();
    expect(update!.changes).toEqual([{ path: 'enabled', from: true, to: false }]);
    expect(update!.before!.enabled).toBe(true);
    expect(update!.after!.enabled).toBe(false);
    expect(archive!.after).toBeNull();
    for (const r of received) {
      expect(verify(r, secret)).toBe(true);
      expect(r.headers['content-type']).toBe('application/json');
    }
  });

  it('a write made through MCP is labelled source "mcp"', async () => {
    const { admin } = await sandboxWithWebhook();
    const proposal = await callTool(app, admin, 'propose_flag_change', {
      key: 'promo-banner',
      change: { type: 'set_enabled', enabled: false },
    });
    const { confirmToken } = proposal.data as { confirmToken: string };
    await callTool(app, admin, 'apply_flag_change', { key: 'promo-banner', confirmToken });
    await settle();

    expect(events().map((e) => [e.type, e.key, e.source])).toEqual([
      ['flag.updated', 'promo-banner', 'mcp'],
    ]);
  });

  it('a project without a webhook sends nothing', async () => {
    const res = await app.request('/v1/sandboxes', { method: 'POST' });
    const { admin } = ((await res.json()) as { keys: { admin: string } }).keys;
    await app.request('/v1/flags', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify(FLAG),
    });
    await settle();
    expect(received).toEqual([]);
  });
});

describe('a failing receiver never touches the write', () => {
  it('a receiver answering 500 gets 3 tries; the write still answered 201 at once', async () => {
    const { admin } = await sandboxWithWebhook();
    answer = 500;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await app.request('/v1/flags', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify(FLAG),
    });
    // The response is complete before any delivery has finished.
    expect(res.status).toBe(201);
    await settle();
    warn.mockRestore();
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers['x-ff-event-id'])).size).toBe(1);
  });

  it('the write never waits for delivery: a dispatch that never ends still gets a 201', async () => {
    const hanging = createApp({ ...deps, dispatch: () => new Promise(() => undefined) });
    const { admin } = await sandboxWithWebhook();
    const res = await hanging.request('/v1/flags', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify(FLAG),
    });
    expect(res.status).toBe(201);
    background = []; // the hanging promise would never settle
  });

  it('a dispatcher that throws is logged, and the write is unaffected', async () => {
    const broken = createApp({
      ...deps,
      dispatch: () => Promise.reject(new Error('database down')),
    });
    const { admin } = await sandboxWithWebhook();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await broken.request('/v1/flags', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify(FLAG),
    });
    expect(res.status).toBe(201);
    await settle();
    const lines = errors.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    errors.mockRestore();
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'webhook dispatch failed', eventType: 'flag.created' }),
    );
  });
});

describe('POST /v1/webhook/test', () => {
  const test = (admin: string) =>
    app.request('/v1/webhook/test', { method: 'POST', headers: auth(admin) });

  it('sends one signed ping now and reports the answer', async () => {
    const { admin, secret } = await sandboxWithWebhook();
    const res = await test(admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: true, attempts: 1, status: 200 });
    expect(events()[0]).toMatchObject({ type: 'ping', key: null });
    expect(verify(received[0]!, secret)).toBe(true);
  });

  it('a refusing receiver: not delivered, its status, one attempt only', async () => {
    const { admin } = await sandboxWithWebhook();
    answer = 401;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await (await test(admin)).json()).toEqual({
      delivered: false,
      attempts: 1,
      status: 401,
    });
    vi.restoreAllMocks();
  });

  it('without a webhook: 404', async () => {
    const res = await app.request('/v1/sandboxes', { method: 'POST' });
    const { admin } = ((await res.json()) as { keys: { admin: string } }).keys;
    expect((await test(admin)).status).toBe(404);
  });
});

describe('postNoFollow (the real sender)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(301, { location: '/elsewhere' });
        return res.end();
      }
      if (req.url === '/slow') return; // never answers
      res.statusCode = req.url === '/elsewhere' ? 200 : 204;
      res.end('ignored body');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const post = (path: string, timeoutMs = 2_000) =>
    postNoFollow(`${base}${path}`, { headers: {}, body: '{}' }, timeoutMs);

  it('returns the status', async () => {
    expect(await post('/ok')).toEqual({ status: 204 });
  });

  it('does not follow redirects: a 301 is the answer', async () => {
    expect(await post('/redirect')).toEqual({ status: 301 });
  });

  it('aborts after the timeout', async () => {
    await expect(post('/slow', 100)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

// Typed use of the FlagEvent import, so a schema rename breaks this file at compile time.
export type _Event = FlagEvent;
