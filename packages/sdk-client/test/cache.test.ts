import { beforeEach, describe, expect, it } from 'vitest';
import { anonymousId, cacheKey, readCache, writeCache } from '../src/cache';

// The browser SDK caches results per (client key, context) in localStorage, so a
// reload can show the last results at once (spec §8.2, plan decision 6).
beforeEach(() => localStorage.clear());

describe('cache key', () => {
  it('the cache key is stable for reordered context keys', () => {
    expect(cacheKey('ck', { userId: 'u1', country: 'PK', plan: 'pro' })).toBe(
      cacheKey('ck', { plan: 'pro', country: 'PK', userId: 'u1' }),
    );
    expect(cacheKey('ck', { userId: 'u1' })).toMatch(/^ff:v1:ck:[0-9a-f]{8}$/);
  });

  it('different contexts get different keys', () => {
    const keys = new Set([
      cacheKey('ck', { userId: 'u1' }),
      cacheKey('ck', { userId: 'u2' }),
      cacheKey('ck', { userId: 'u1', country: 'PK' }),
      cacheKey('other', { userId: 'u1' }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('anonymous id', () => {
  it('the anonymous id is created once and reused', () => {
    const first = anonymousId(localStorage);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(anonymousId(localStorage)).toBe(first);
    expect(localStorage.getItem('ff:anon-id')).toBe(first);
  });

  it('without storage it still returns an id, just not a remembered one', () => {
    expect(anonymousId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('cache size (final review I5)', () => {
  const body = { version: 1, flags: {} };

  it('keeps only the 5 most recently written visitors per client key', () => {
    const contexts = Array.from({ length: 7 }, (_, i) => ({ userId: `u${i}` }));
    for (const c of contexts) writeCache(localStorage, 'ck', c, body);

    // 5 entries + 1 index; the two oldest are gone, so storage can't fill up.
    expect(localStorage.length).toBe(6);
    expect(readCache(localStorage, cacheKey('ck', contexts[0]!))).toBeNull();
    expect(readCache(localStorage, cacheKey('ck', contexts[1]!))).toBeNull();
    expect(readCache(localStorage, cacheKey('ck', contexts[6]!))).toEqual(body);
  });

  it('writing a visitor again makes it the most recent', () => {
    const contexts = Array.from({ length: 5 }, (_, i) => ({ userId: `u${i}` }));
    for (const c of contexts) writeCache(localStorage, 'ck', c, body);
    writeCache(localStorage, 'ck', contexts[0]!, body); // u0 is fresh again
    writeCache(localStorage, 'ck', { userId: 'new' }, body); // evicts u1, not u0

    expect(readCache(localStorage, cacheKey('ck', contexts[0]!))).toEqual(body);
    expect(readCache(localStorage, cacheKey('ck', contexts[1]!))).toBeNull();
  });

  it('other client keys are left alone', () => {
    writeCache(localStorage, 'other', { userId: 'x' }, body);
    for (let i = 0; i < 7; i++) writeCache(localStorage, 'ck', { userId: `u${i}` }, body);
    expect(readCache(localStorage, cacheKey('other', { userId: 'x' }))).toEqual(body);
  });
});
