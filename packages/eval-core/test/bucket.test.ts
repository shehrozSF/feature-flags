import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketFor, pickRolloutVariant } from '../src/bucket';
import { murmur3_32 } from '../src/murmur3';
import type { RolloutEntry } from '../src/types';

describe('bucketFor', () => {
  it('matches the spec formula', () => {
    expect(bucketFor('salt1', 'user-42')).toBe(murmur3_32('salt1.user-42', 0) % 10000);
  });

  it('returns 0 for a missing value', () => {
    expect(bucketFor('s', undefined)).toBe(0);
  });

  it('number and string forms of the same id share a bucket', () => {
    expect(bucketFor('s', 12345)).toBe(bucketFor('s', '12345'));
  });

  it('is always within [0, 9999]', () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucketFor('s', `user-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BUCKET_COUNT);
    }
  });
});

describe('pickRolloutVariant', () => {
  const rollout: RolloutEntry[] = [
    { variant: 'a', weight: 2000 },
    { variant: 'b', weight: 3000 },
    { variant: 'c', weight: 5000 },
  ];

  it.each([
    { bucket: 0, expected: 'a' },
    { bucket: 1999, expected: 'a' },
    { bucket: 2000, expected: 'b' },
    { bucket: 4999, expected: 'b' },
    { bucket: 5000, expected: 'c' },
    { bucket: 9999, expected: 'c' },
  ])('bucket $bucket → $expected', ({ bucket, expected }) => {
    expect(pickRolloutVariant(rollout, bucket)).toBe(expected);
  });

  it('returns null when weights do not cover the bucket', () => {
    expect(pickRolloutVariant([{ variant: 'a', weight: 5000 }], 7000)).toBeNull();
    expect(pickRolloutVariant([], 0)).toBeNull();
  });

  it('zero-weight variants never win', () => {
    const r = [
      { variant: 'a', weight: 0 },
      { variant: 'b', weight: 10000 },
    ];
    expect(pickRolloutVariant(r, 0)).toBe('b');
  });
});
