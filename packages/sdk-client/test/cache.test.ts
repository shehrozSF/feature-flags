import { beforeEach, describe, expect, it } from 'vitest';
import { anonymousId, cacheKey } from '../src/cache';

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
