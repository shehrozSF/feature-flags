import type { Flag, Ruleset } from '@ff/eval-core';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker, NEW_PRICE, OLD_PRICE } from '../src/app';

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  // In production, work a request starts is cut off when its response is sent
  // unless it is handed to ctx.waitUntil. The test pool keeps timers and fetches
  // alive, so "it updates eventually" would pass even with that bug; these tests
  // check the hand-over itself: an unsettled refresh must reach waitUntil.
  function recordingCtx() {
    const handed: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void handed.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    return { ctx, handed };
  }
  /** True if the promise has already settled (checked after a few microtask turns). */
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return done;
  };
  /** A fake API whose next rules answer the test releases by hand. */
  function heldApi(first: Ruleset | null) {
    let release: ((res: Response) => void) | null = null;
    let calls = 0;
    const fetch = () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          first
            ? Response.json(first, { headers: { etag: 'W/"1"' } })
            : Response.json({ status: 500 }, { status: 500 }),
        );
      }
      return new Promise<Response>((resolve) => (release = resolve));
    };
    return { fetch, release: (res: Response) => release!(res), calls: () => calls };
  }

  it('a refresh started by a request is handed to waitUntil', async () => {
    const api = heldApi(rules(false));
    const worker = createWorker({ fetch: api.fetch });
    const { path, init } = price(serverKey('A'), '?plan=free');
    await call(worker, path, init); // first load
    await new Promise((r) => setTimeout(r, 1100)); // past the SDK's 1 s cache

    const { ctx, handed } = recordingCtx();
    const res = await worker.fetch(new Request(`https://backend.example${path}`, init), env, ctx);
    expect(res.status).toBe(200);
    expect(api.calls()).toBe(2); // this request started a refresh…
    expect(await Promise.all(handed.map(settled))).toContain(false); // …and handed it over
    api.release(Response.json(rules(true), { headers: { etag: 'W/"2"' } }));
  });

  it('a 503 still hands a retry to waitUntil, so the key can recover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // backoff after the failure: 100 ms
    // In production the SDK's own retry timer dies with the request that set it.
    // Fake timers never fire here, which is the same thing; only the clock moves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = heldApi(null); // the first load fails
    const worker = createWorker({ fetch: api.fetch });
    const { path, init } = price(serverKey('A'), '?plan=free');
    expect((await call(worker, path, init)).status).toBe(503);
    vi.setSystemTime(Date.now() + 1000); // past the backoff; no timer has run

    const { ctx, handed } = recordingCtx();
    const res = await worker.fetch(new Request(`https://backend.example${path}`, init), env, ctx);
    expect(res.status).toBe(503);
    expect(await Promise.all(handed.map(settled))).toContain(false); // a retry is in flight
    api.release(Response.json(rules(true), { headers: { etag: 'W/"1"' } }));
    await Promise.all(handed);
    expect((await call(worker, path, init)).status).toBe(200); // and the key recovered
  });

  it('the main module exports only the handler', async () => {
    // workerd treats every named export of the main module as an entrypoint and
    // refuses to start on anything else (a number, a helper). The test pool is more
    // lenient than the real runtime, so check the exports themselves (issues #66).
    expect(Object.keys(await import('../src/worker'))).toEqual(['default']);
    const res = await exports.default.fetch(new Request('https://backend.example/health'));
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('in production the rules come through the API service binding', async () => {
    // A Worker can't fetch another Worker's workers.dev URL on the same account
    // (404, issues #69), so the deployed backend must use the binding, not fetch.
    const api = fakeApi({ [serverKey('A')]: rules(true) });
    const binding = { fetch: vi.fn(api.fetch) };
    const worker = createWorker(); // no injected fetch: as deployed
    const ctx = createExecutionContext();
    const { path, init } = price(serverKey('A'), '?plan=free');
    const res = await worker.fetch(
      new Request(`https://backend.example${path}`, init),
      // API_URL unreachable: a backend that wrongly used plain fetch fails fast here.
      {
        ...env,
        API_URL: 'http://127.0.0.1:9',
        API_VIA: 'binding',
        API: binding as unknown as Fetcher,
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalled();
  });

  it('health works', async () => {
    const res = await call(createWorker({ fetch: fakeApi({}).fetch }), '/health');
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
