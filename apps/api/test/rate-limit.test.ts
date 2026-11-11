import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter, slidingLog } from '../src/rate-limit';

// A sliding log: remember when each allowed request happened (at most `limit` of
// them) and allow a new one only if fewer than `limit` fall inside the window.
// Pure, with the clock passed in, so time is just a number in these tests.
const HOUR = 60 * 60 * 1000;

describe('slidingLog', () => {
  it('allows up to the limit, then refuses until the oldest leaves the window', () => {
    let log: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = slidingLog(log, i * 1000, 5, HOUR);
      expect(r.ok).toBe(true);
      if (r.ok) log = r.log;
    }
    const sixth = slidingLog(log, 10_000, 5, HOUR);
    // The oldest (t=0) leaves the window at t=HOUR, so the wait is HOUR - 10 s.
    expect(sixth).toEqual({ ok: false, retryAfterMs: HOUR - 10_000 });
  });

  it('the window slides: one more is allowed just after the oldest expires', () => {
    const log = [0, 1000, 2000, 3000, 4000];
    expect(slidingLog(log, HOUR - 1, 5, HOUR).ok).toBe(false);
    const r = slidingLog(log, HOUR + 1, 5, HOUR);
    expect(r).toEqual({ ok: true, log: [1000, 2000, 3000, 4000, HOUR + 1] });
  });

  it('keeps no more than `limit` timestamps, so storage stays small', () => {
    let log: number[] = [];
    for (let t = 0; t < 50 * HOUR; t += HOUR / 2) {
      const r = slidingLog(log, t, 5, HOUR);
      if (r.ok) log = r.log;
      expect(log.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('MemoryRateLimiter', () => {
  it('keeps a separate log per key', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 2; i++) expect((await limiter.take('a', 2, HOUR)).ok).toBe(true);
    expect((await limiter.take('a', 2, HOUR)).ok).toBe(false);
    expect((await limiter.take('b', 2, HOUR)).ok).toBe(true);
    now = HOUR + 1;
    expect((await limiter.take('a', 2, HOUR)).ok).toBe(true);
  });
});
