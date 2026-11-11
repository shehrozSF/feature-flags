import type { Flag, Ruleset } from '@ff/eval-core';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker, NEW_PRICE, OLD_PRICE } from '../src/worker';

// The demo shop's pricing backend, in workerd: it reads the visitor's own sandbox
// flags with the server SDK (polling mode) and prices accordingly (spec §9.4).
const ID = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const serverKey = (c: string) => `ff_server_${ID}_${c.repeat(43)}`;
const DEMO_ORIGIN = 'https://shehrozsf.github.io';

const onOff = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];
/** new-pricing: on for plan pro, otherwise `defaultOn`. */
const rules = (defaultOn: boolean): Ruleset => {
  const flag: Flag = {
    key: 'new-pricing',
    enabled: true,
    variants: onOff,
    offVariant: 'off',
    rules: [
      {
        id: 'pro-plan',
        conditions: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
        serve: { variant: 'on' },
      },
    ],
    defaultServe: { variant: defaultOn ? 'on' : 'off' },
    salt: 'np',
    version: 1,
  };
  return { projectVersion: 1, flags: { 'new-pricing': flag } };
};

/** The flag API: rules per server key; unknown keys get 401, like the real one. */
function fakeApi(byKey: Record<string, Ruleset>) {
  const calls: string[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    calls.push(key);
    const ruleset = byKey[key];
    return Promise.resolve(
      ruleset
        ? Response.json(ruleset, { headers: { etag: 'W/"1"' } })
        : Response.json({ status: 401 }, { status: 401 }),
    );
  };
  return { fetch, calls };
}

async function call(worker: ReturnType<typeof createWorker>, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://backend.example${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const price = (key: string, query = '') => ({
  path: `/price${query}`,
  init: { headers: { 'x-ff-server-key': key, origin: DEMO_ORIGIN } },
});

afterEach(() => vi.restoreAllMocks());

describe('demo-backend /price', () => {
  it('new-pricing on gives the new price', async () => {
    const worker = createWorker({ fetch: fakeApi({ [serverKey('A')]: rules(true) }).fetch });
    const { path, init } = price(serverKey('A'), '?userId=u1&plan=free');
    const res = await call(worker, path, init);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      plan: 'free',
      price: NEW_PRICE,
      currency: 'USD',
      newPricing: true,
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(DEMO_ORIGIN);
  });

  it('plan pro gets new pricing via the rule; free does not', async () => {
    const worker = createWorker({ fetch: fakeApi({ [serverKey('A')]: rules(false) }).fetch });
    const pro = await call(
      worker,
      price(serverKey('A'), '?userId=u1&plan=pro').path,
      price(serverKey('A')).init,
    );
    const free = await call(
      worker,
      price(serverKey('A'), '?userId=u1&plan=free').path,
      price(serverKey('A')).init,
    );
    expect(await pro.json()).toMatchObject({ price: NEW_PRICE, newPricing: true });
    expect(await free.json()).toMatchObject({ price: OLD_PRICE, newPricing: false });
  });

  it('a missing or malformed key gets 400', async () => {
    const worker = createWorker({ fetch: fakeApi({}).fetch });
    for (const headers of [
      {},
      { 'x-ff-server-key': 'nope' },
      { 'x-ff-server-key': `ff_client_${ID}_${'A'.repeat(43)}` },
    ]) {
      const res = await call(worker, '/price', { headers });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('a key the API rejects gets 503 with Retry-After', async () => {
    const worker = createWorker({ fetch: fakeApi({}).fetch });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { path, init } = price(serverKey('Z'));
    const res = await call(worker, path, init);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('one SDK client per key is reused across requests', async () => {
    const api = fakeApi({ [serverKey('A')]: rules(true) });
    const worker = createWorker({ fetch: api.fetch });
    for (let i = 0; i < 3; i++)
      await call(worker, price(serverKey('A')).path, price(serverKey('A')).init);
    expect(api.calls).toEqual([serverKey('A')]); // one rules fetch, not three
  });

  it('the client cache is bounded', async () => {
    const keys = ['A', 'B', 'C', 'D'].map(serverKey);
    const api = fakeApi(Object.fromEntries(keys.map((k) => [k, rules(true)])));
    const worker = createWorker({ fetch: api.fetch, maxClients: 3 });
    for (const k of keys) await call(worker, price(k).path, price(k).init); // A is evicted by D
    await call(worker, price(keys[0]!).path, price(keys[0]!).init);

    expect(api.calls.filter((k) => k === keys[0])).toHaveLength(2); // A had to start again
  });

  it('preflight allows the demo origin and the key header', async () => {
    const worker = createWorker({ fetch: fakeApi({}).fetch });
    const res = await call(worker, '/price', {
      method: 'OPTIONS',
      headers: { origin: DEMO_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DEMO_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-ff-server-key');

    const other = await call(worker, '/price', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('the key never appears in a response or a log', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation(
        (...args: unknown[]) => void logged.push(...args),
      );
    }
    const worker = createWorker({ fetch: fakeApi({ [serverKey('A')]: rules(true) }).fetch });
    const bodies: string[] = [];
    for (const k of [serverKey('A'), serverKey('Z'), 'nope']) {
      const res = await call(worker, '/price', { headers: { 'x-ff-server-key': k } });
      bodies.push(await res.text(), JSON.stringify([...res.headers]));
    }
    const everything = JSON.stringify(logged) + bodies.join('\n');
    expect(everything).not.toContain(serverKey('A'));
    expect(everything).not.toContain(serverKey('Z'));
  });

  it('health works', async () => {
    const res = await call(createWorker({ fetch: fakeApi({}).fetch }), '/health');
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
