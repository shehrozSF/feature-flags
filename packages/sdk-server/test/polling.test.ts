import { startFakeApi, type FakeApi } from '@ff/fault-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient } from '../src/index';
import { json, ruleset, scriptedFetch, silentLogger } from './fixtures';

// Polling mode (spec §8.1): rules live in memory; a variation call after
// cacheTtlMs starts a background revalidation and returns the current value at once.
const TTL = 100;
const PK = { userId: 'u1', country: 'PK' };

let api: FakeApi;
let client: ServerClient;
const rulesRequests = () => api.requests.filter((r) => r.path === '/v1/sdk/rules').length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  api = await startFakeApi({ ruleset: ruleset(1) });
  client = await createServerClient({
    serverKey: api.keys.server,
    baseUrl: api.url,
    mode: 'polling',
    cacheTtlMs: TTL,
  });
});
afterEach(async () => {
  client.close();
  await api.close();
});

describe('server SDK: polling mode', () => {
  it('polling reuses rules within cacheTtlMs', () => {
    for (let i = 0; i < 50; i++) client.variation('promo-banner', PK, false);
    expect(rulesRequests()).toBe(1); // only the initial load
  });

  it('polling revalidates in the background after cacheTtlMs', async () => {
    api.publish(ruleset(2, false));
    await sleep(TTL + 20);

    expect(client.variation('promo-banner', PK, true)).toBe(true); // old value, at once
    await vi.waitFor(() => expect(client.variation('promo-banner', PK, true)).toBe(false));
    expect(client.version()).toBe(2);
  });

  it('polling revalidates once, not per call', async () => {
    await sleep(TTL + 20);
    for (let i = 0; i < 100; i++) client.variation('promo-banner', PK, false);
    await vi.waitFor(() => expect(rulesRequests()).toBe(2));
    await sleep(50);
    expect(rulesRequests()).toBe(2);
  });

  it('refresh() can be awaited', async () => {
    // A Worker passes this to ctx.waitUntil, so the refresh outlives the response.
    api.publish(ruleset(2, false));
    await client.refresh();
    expect(client.variation('promo-banner', PK, true)).toBe(false);
  });

  it('concurrent refresh calls share one request', async () => {
    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
    expect(rulesRequests()).toBe(2); // initial load + one shared revalidation
  });

  it('change fires with the new version', async () => {
    const seen: number[] = [];
    const unsubscribe = client.on('change', (version) => seen.push(version));
    api.publish(ruleset(2));
    await client.refresh();
    unsubscribe();
    api.publish(ruleset(3));
    await client.refresh();

    expect(seen).toEqual([2]);
  });
});

// In a Worker, timers and I/O started during one request die when that request
// ends. vi.setSystemTime moves the clock WITHOUT running timers, which is exactly
// what a later request sees (final review I2).
describe('server SDK: polling in Workers (final review I2)', () => {
  const workerClient = async (responses: Parameters<typeof scriptedFetch>[0]) => {
    vi.useFakeTimers();
    const { fetch, calls } = scriptedFetch(responses);
    const c = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      cacheTtlMs: TTL,
      fetch,
      backoff: { baseMs: 20, capMs: 100 },
      random: () => 1,
      logger: silentLogger().logger,
    });
    return { c, calls };
  };
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  afterEach(() => vi.useRealTimers());

  it('a fetch that never settles is abandoned, so revalidation continues', async () => {
    const { c, calls } = await workerClient([
      () => json(ruleset(1)),
      () => new Promise<Response>(() => undefined), // its request ended; it will never settle
      () => json(ruleset(2, false)),
    ]);
    later(TTL + 1);
    c.variation('promo-banner', PK, false); // starts fetch #2, which hangs
    expect(calls).toHaveLength(2);

    later(15_000); // past the request timeout, whose timer never fired
    c.variation('promo-banner', PK, false);
    expect(calls).toHaveLength(3);
    await c.pending();
    expect(c.version()).toBe(2);
    c.close();
  });

  it('pending() waits for the background revalidation and costs nothing otherwise', async () => {
    const { c, calls } = await workerClient([() => json(ruleset(1)), () => json(ruleset(2))]);
    await c.pending(); // nothing in flight: no request
    expect(calls).toHaveLength(1);

    later(TTL + 1);
    c.variation('promo-banner', PK, false);
    await c.pending(); // what a Worker hands to ctx.waitUntil
    expect(c.version()).toBe(2);
    await c.pending();
    expect(calls).toHaveLength(2);
    c.close();
  });

  it('a failed start recovers on a later request even if its retry timers died', async () => {
    const { c, calls } = await workerClient([
      () => new Response(null, { status: 503 }),
      () => json(ruleset(1)),
    ]);
    expect(c.version()).toBeNull();

    later(5_000); // the retry timer from the first request never fires
    expect(c.variation('promo-banner', PK, false)).toBe(false); // fallback now…
    expect(calls).toHaveLength(2); // …but a new attempt started
    await c.pending();
    expect(c.variation('promo-banner', PK, false)).toBe(true);
    c.close();
  });
});
