import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '../src/adapters/cloudflare/rate-limiter';

// The RateLimiter Durable Object: one per key (e.g. "sandbox:<ip>"), keeping a
// sliding log in its storage. One object handles one request at a time, so two
// requests can't both read "4 so far" and both get through.
type LimiterStub = DurableObjectStub<RateLimiter>;
const newLimiter = () => env.RATE_LIMITER.getByName(crypto.randomUUID()) as LimiterStub;
const HOUR = 60 * 60 * 1000;

describe('RateLimiter', () => {
  it('allows the limit, then refuses with how long to wait', async () => {
    const limiter = newLimiter();
    for (let i = 0; i < 5; i++) expect(await limiter.take(5, HOUR)).toEqual({ ok: true });
    const refused = await limiter.take(5, HOUR);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBeGreaterThan(HOUR - 60_000);
  });

  it('parallel requests cannot overshoot the limit', async () => {
    const limiter = newLimiter();
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.take(5, HOUR)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it('the log survives being evicted from memory', async () => {
    const limiter = newLimiter();
    for (let i = 0; i < 5; i++) await limiter.take(5, HOUR);
    await evictDurableObject(limiter);
    expect((await limiter.take(5, HOUR)).ok).toBe(false);
  });

  it('an alarm deletes the log once the window has passed, so idle IPs leave nothing behind', async () => {
    const limiter = newLimiter();
    const before = Date.now();
    await limiter.take(5, HOUR);
    // Set for when the newest entry leaves the window...
    const alarm = await runInDurableObject(limiter, (_, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + HOUR);
    expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR);
    // ...and when it runs (run now, rather than waiting an hour), the log is gone.
    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    const keys = await runInDurableObject(limiter, async (_, state) => [
      ...(await state.storage.list()).keys(),
    ]);
    expect(keys).toEqual([]);
  });
});
