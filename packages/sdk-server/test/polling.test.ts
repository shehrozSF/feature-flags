import { startFakeApi, type FakeApi } from '@ff/fault-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient } from '../src/index';
import { ruleset } from './fixtures';

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
