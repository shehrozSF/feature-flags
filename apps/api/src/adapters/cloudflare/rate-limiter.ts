import { DurableObject } from 'cloudflare:workers';
import { slidingLog, type Take } from '../../rate-limit';
import type { Env } from './env';

/**
 * One per limited key, addressed by name (e.g. "sandbox:<ip>"). A Durable Object
 * runs one request at a time, so concurrent requests can't both see room. The log
 * lives in storage, so it survives eviction; an alarm deletes it once the window
 * has passed, so an IP that stops visiting leaves nothing behind.
 */
export class RateLimiter extends DurableObject<Env> {
  async take(limit: number, windowMs: number): Promise<Take> {
    const now = Date.now();
    const result = slidingLog(
      (await this.ctx.storage.get<number[]>('log')) ?? [],
      now,
      limit,
      windowMs,
    );
    if (!result.ok) return result;
    await this.ctx.storage.put('log', result.log);
    // The newest entry is the last to leave the window.
    await this.ctx.storage.setAlarm(now + windowMs);
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
