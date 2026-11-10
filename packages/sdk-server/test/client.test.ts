import { startFakeApi, type FakeApi } from '@ff/fault-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerClient, type ServerClient } from '../src/index';
import { json, ruleset, scriptedFetch, silentLogger } from './fixtures';

// The server SDK's start-up and local evaluation (spec §8.1), against the fake API
// or a scripted fetch when a test needs exact control over each response.
let api: FakeApi | undefined;
let client: ServerClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await api?.close();
  api = undefined;
  vi.useRealTimers();
});

const PK = { userId: 'u1', country: 'PK' };

describe('server SDK: start-up and variation', () => {
  it('init loads rules and variation evaluates locally', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) });
    client = await createServerClient({
      serverKey: api.keys.server,
      baseUrl: api.url,
      mode: 'polling',
    });

    expect(client.version()).toBe(1);
    expect(client.variation('pk-local-payments', PK, false)).toBe(true);
    expect(client.variation('pk-local-payments', { userId: 'u2', country: 'US' }, true)).toBe(
      false,
    );
    expect(client.variationDetail('pk-local-payments', PK, false)).toMatchObject({
      reason: 'RULE_MATCH',
      ruleId: 'pakistan',
    });
  });

  it('init resolves at timeoutMs with fallbacks when the API is slow', async () => {
    const { fetch } = scriptedFetch([]); // never answers
    const started = Date.now();
    client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      timeoutMs: 100,
      fetch,
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(client.version()).toBeNull();
    expect(client.variationDetail('promo-banner', PK, false)).toEqual({
      variant: null,
      value: false,
      reason: 'ERROR',
    });
  });

  it('variation never throws', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) });
    client = await createServerClient({
      serverKey: api.keys.server,
      baseUrl: api.url,
      mode: 'polling',
    });

    expect(client.variationDetail('no-such-flag', PK, 'x')).toMatchObject({
      value: 'x',
      reason: 'FLAG_NOT_FOUND',
    });
    // A context that throws on any access (evaluate checks Object.hasOwn before
    // reading, so throwing on reads alone would just look like a missing attribute).
    const boom = () => {
      throw new Error('boom');
    };
    const hostile = new Proxy(
      {},
      { get: boom, has: boom, getOwnPropertyDescriptor: boom, ownKeys: boom },
    );
    expect(() => client!.variation('pk-local-payments', hostile, false)).not.toThrow();
    expect(client.variationDetail('pk-local-payments', hostile, false).reason).toBe('ERROR');
  });

  it('a value of the wrong type returns the fallback', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) });
    client = await createServerClient({
      serverKey: api.keys.server,
      baseUrl: api.url,
      mode: 'polling',
    });

    expect(client.variation('cta-color', PK, 'red')).toBe('blue'); // string asked, string served
    expect(client.variationDetail('cta-color', PK, false)).toEqual({
      variant: null,
      value: false,
      reason: 'ERROR',
    });
  });

  it('an older ruleset never replaces a newer one', async () => {
    const { fetch } = scriptedFetch([
      () => json(ruleset(3), { headers: { etag: 'W/"3"' } }),
      () => json(ruleset(2, false), { headers: { etag: 'W/"2"' } }),
    ]);
    client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      fetch,
    });
    await client.refresh();

    expect(client.version()).toBe(3);
    expect(client.variation('promo-banner', PK, false)).toBe(true);
  });

  it('an invalid response keeps the last good rules', async () => {
    const { warnings, logger } = silentLogger();
    const { fetch } = scriptedFetch([
      () => json(ruleset(1), { headers: { etag: 'W/"1"' } }),
      () => json({ projectVersion: 'x' }, { headers: { etag: 'W/"2"' } }),
    ]);
    client = await createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      fetch,
      logger,
    });
    await client.refresh();

    expect(client.version()).toBe(1);
    expect(client.variation('promo-banner', PK, false)).toBe(true);
    expect(warnings.join('\n')).toMatch(/invalid/i);
  });

  it('the ETag is sent back exactly as received', async () => {
    api = await startFakeApi({ ruleset: ruleset(1) }); // weak ETags, like Cloudflare
    client = await createServerClient({
      serverKey: api.keys.server,
      baseUrl: api.url,
      mode: 'polling',
    });
    await client.refresh();

    const rules = api.requests.filter((r) => r.path === '/v1/sdk/rules');
    expect(rules).toHaveLength(2);
    expect(rules[0]!.headers['if-none-match']).toBeUndefined();
    expect(rules[1]!.headers['if-none-match']).toBe('W/"1"');
    expect(rules[1]!.headers.authorization).toBe(`Bearer ${api.keys.server}`);
  });

  it('503 with Retry-After waits before the next attempt', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = scriptedFetch([
      () => new Response(null, { status: 503, headers: { 'retry-after': '2' } }),
      () => json(ruleset(1)),
    ]);
    const ready = createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      timeoutMs: 100,
      fetch,
      random: () => 0, // backoff alone would retry at once
      logger: silentLogger().logger,
    });
    await vi.advanceTimersByTimeAsync(100);
    client = await ready;

    await vi.advanceTimersByTimeAsync(1_800);
    expect(calls).toHaveLength(1); // still waiting out Retry-After
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(2);
    expect(client.version()).toBe(1);
  });

  it('close during init stops everything', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = scriptedFetch([]); // never answers
    const ready = createServerClient({
      serverKey: 'k',
      baseUrl: 'http://api',
      mode: 'polling',
      timeoutMs: 100,
      fetch,
      random: () => 0.5,
      logger: silentLogger().logger,
    });
    await vi.advanceTimersByTimeAsync(100);
    client = await ready;
    client.close();
    expect(vi.getTimerCount()).toBe(0); // nothing left scheduled, right away

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1); // no retries after close
    expect(vi.getTimerCount()).toBe(0);
  });
});
