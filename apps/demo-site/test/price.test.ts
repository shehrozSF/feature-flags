import { describe, expect, it, vi } from 'vitest';
import { createPriceSource } from '../src/price';

// The browser side of the pricing call: what it sends, and what it refuses.
const KEY = `ff_server_3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f_${'A'.repeat(43)}`;
const PRICE = { plan: 'pro', price: 19, currency: 'USD', newPricing: true };

describe('createPriceSource', () => {
  it('sends the key in the header and the visitor in the query', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(PRICE)));
    const source = createPriceSource({
      baseUrl: 'https://backend.example/',
      serverKey: KEY,
      fetch,
    });

    expect(await source({ userId: 'u1', country: 'PK', plan: 'pro' })).toEqual(PRICE);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://backend.example/price?userId=u1&country=PK&plan=pro');
    expect(new Headers(init?.headers).get('x-ff-server-key')).toBe(KEY);
    expect(url).not.toContain(KEY); // never in a URL, where it would end up in logs
  });

  it('leaves out an empty userId', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(PRICE)));
    await createPriceSource({ baseUrl: 'https://b.example', serverKey: KEY, fetch })({
      country: 'US',
      plan: 'free',
    });
    expect(fetch.mock.calls[0]![0]).toBe('https://b.example/price?country=US&plan=free');
  });

  it('rejects an error status or an unexpected body', async () => {
    for (const res of [
      Response.json({ status: 503 }, { status: 503 }),
      Response.json({ price: '19' }),
    ]) {
      const source = createPriceSource({
        baseUrl: 'https://b.example',
        serverKey: KEY,
        fetch: () => Promise.resolve(res),
      });
      await expect(source({ country: 'US', plan: 'free' })).rejects.toThrow();
    }
  });
});
