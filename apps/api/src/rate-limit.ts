// Rate limiting by sliding log (spec §9.2): remember when each allowed request
// happened, at most `limit` of them, and allow a new one only if fewer than
// `limit` fall inside the window. Exact (no burst at window edges), and small:
// for "5 an hour" it stores 5 numbers. The rule is a pure function, shared by the
// RateLimiter Durable Object and MemoryRateLimiter, so they can't drift.

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

export function slidingLog(
  log: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): { ok: true; log: number[] } | { ok: false; retryAfterMs: number } {
  const recent = log.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    // Room again when the oldest of the last `limit` requests leaves the window.
    const oldest = recent[recent.length - limit]!;
    return { ok: false, retryAfterMs: oldest + windowMs - now };
  }
  return { ok: true, log: [...recent, now].slice(-limit) };
}

/** Takes one request from `key`'s allowance. */
export interface RateLimiter {
  take(key: string, limit: number, windowMs: number): Promise<Take>;
}

/** In memory, per process: Node tests and the local Node server. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly logs = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, limit: number, windowMs: number): Promise<Take> {
    const result = slidingLog(this.logs.get(key) ?? [], this.now(), limit, windowMs);
    if (!result.ok) return Promise.resolve(result);
    this.logs.set(key, result.log);
    return Promise.resolve({ ok: true });
  }
}
