import { fakeSockets } from '@ff/fault-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../src/cache';
import { createBrowserClient, type BrowserClient } from '../src/index';
import { json, manualFetch, results, throwingStorage } from './fixtures';

// The browser SDK (spec §8.2): the API evaluates every flag for the visitor; the
// SDK caches the results, serves them synchronously and swaps in fresh ones.
const KEY = 'ff_client_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_' + 'A'.repeat(43);
const PK = { userId: 'u1', country: 'PK' };

let client: BrowserClient | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  client?.close();
  client = undefined;
  vi.useRealTimers();
});

const start = (options: Partial<Parameters<typeof createBrowserClient>[0]> = {}) => {
  const f = manualFetch();
  client = createBrowserClient({
    clientKey: KEY,
    baseUrl: 'http://api',
    context: PK,
    fetch: f.fetch,
    storage: localStorage,
    // Live updates are tested in live.test.ts; here sockets stay in memory, off the network.
    webSocket: (url) => fakeSockets().webSocket(url, {}),
    ...options,
  });
  return { client, calls: f.calls };
};

describe('browser SDK: start-up, cache, identify', () => {
  it('ready resolves at once from cache, then fresh results replace it', async () => {
    localStorage.setItem(cacheKey(KEY, PK), JSON.stringify(results(1, true)));
    const { client, calls } = start();
    const changes = vi.fn();
    client.on('change', changes);

    await client.ready(); // no network answer yet
    expect(client.variation('promo-banner', false)).toBe(true);

    calls[0]!.respond(json(results(2, false)));
    await vi.waitFor(() => expect(client.variation('promo-banner', true)).toBe(false));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(cacheKey(KEY, PK))!)).toEqual(results(2, false));
  });

  it('ready resolves after the first evaluate without a cache', async () => {
    const { client, calls } = start();
    let ready = false;
    void client.ready().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);

    expect(calls[0]!.url).toBe('http://api/v1/client/evaluate');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({ context: PK });
    calls[0]!.respond(json(results(1)));
    await client.ready();
    expect(client.variation('cta-color', 'red')).toBe('blue');
  });

  it('ready resolves at timeoutMs with fallbacks when the API is slow', async () => {
    const { client } = start({ timeoutMs: 100 });
    const started = Date.now();
    await client.ready();
    expect(Date.now() - started).toBeLessThan(500);
    expect(client.variationDetail('promo-banner', false)).toEqual({
      variant: null,
      value: false,
      reason: 'ERROR',
    });
  });

  it('a missing userId uses the anonymous id', () => {
    const { calls } = start({ context: { country: 'PK' } });
    const anon = localStorage.getItem('ff:anon-id');
    expect(anon).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.body).toEqual({ context: { country: 'PK', userId: anon } });
  });

  it('identify re-evaluates for the new context', async () => {
    const { client, calls } = start();
    calls[0]!.respond(json(results(1, true)));
    await client.ready();

    const done = client.identify({ userId: 'u2', country: 'US' });
    expect(calls[1]!.body).toEqual({ context: { userId: 'u2', country: 'US' } });
    calls[1]!.respond(json(results(1, false)));
    await done;
    expect(client.variation('promo-banner', true)).toBe(false);
  });

  it('a late response for the previous context is dropped', async () => {
    const { client, calls } = start();
    const identified = client.identify({ userId: 'u2' }); // first evaluate still pending

    calls[1]!.respond(json(results(1, false))); // the new context answers first
    await identified;
    calls[0]!.respond(json(results(5, true))); // then the old one, even with a newer version
    await new Promise((r) => setTimeout(r, 10));

    expect(client.variation('promo-banner', true)).toBe(false);
  });

  it('an older version never replaces a newer one', async () => {
    localStorage.setItem(cacheKey(KEY, PK), JSON.stringify(results(3, false)));
    const { client, calls } = start();
    calls[0]!.respond(json(results(2, true))); // e.g. a lagging edge cache
    await new Promise((r) => setTimeout(r, 10));

    expect(client.variation('promo-banner', true)).toBe(false);
    expect(JSON.parse(localStorage.getItem(cacheKey(KEY, PK))!)).toEqual(results(3, false));
  });

  it('an invalid response keeps the previous results', async () => {
    const { client, calls } = start();
    calls[0]!.respond(json(results(1, true)));
    await client.ready();

    const again = client.identify(PK); // same context, re-evaluate
    calls[1]!.respond(json({ version: 'x', flags: 'nope' }));
    await again;
    expect(client.variation('promo-banner', false)).toBe(true);
  });

  it('503 with Retry-After waits before the next evaluate', async () => {
    vi.useFakeTimers();
    const { client, calls } = start({ random: () => 0 });
    calls[0]!.respond(new Response(null, { status: 503, headers: { 'retry-after': '2' } }));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(calls).toHaveLength(1); // waiting out Retry-After
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    calls[1]!.respond(json(results(1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.variation('promo-banner', false)).toBe(true);
  });

  it.each([400, 401, 403, 413, 422])(
    'a %i is reported once and not retried (final review I4)',
    async (status) => {
      vi.useFakeTimers();
      const warnings: string[] = [];
      const { client, calls } = start({
        random: () => 0,
        logger: { warn: (m: string) => warnings.push(m) },
      });
      calls[0]!.respond(json({ status }, { status }));
      await vi.advanceTimersByTimeAsync(120_000);

      expect(calls).toHaveLength(1); // retrying can't fix a bad key or a rejected context
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(String(status));
      expect(warnings[0]).not.toMatch(/u1|PK/); // never log the context (PII, spec §9.3)

      // A different visitor (or a fixed context) gets a fresh try.
      void client.identify({ userId: 'u2' });
      expect(calls).toHaveLength(2);
    },
  );

  it('works when storage throws', async () => {
    const { client, calls } = start({ storage: throwingStorage(), context: { country: 'PK' } });
    expect((calls[0]!.body as { context: { userId?: string } }).context.userId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    calls[0]!.respond(json(results(1)));
    await client.ready();
    expect(client.variation('promo-banner', false)).toBe(true);
  });

  it('a value of the wrong type returns the fallback', async () => {
    const { client, calls } = start();
    calls[0]!.respond(json(results(1)));
    await client.ready();
    expect(client.variation('cta-color', false)).toBe(false);
    expect(client.variationDetail('cta-color', false).reason).toBe('ERROR');
    expect(client.variationDetail('no-such-flag', 'x')).toMatchObject({
      value: 'x',
      reason: 'FLAG_NOT_FOUND',
    });
  });
});
