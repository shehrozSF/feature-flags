import { describe, expect, it } from 'vitest';
import { murmur3_32, murmur3_32Bytes } from '../src/murmur3';

// Expected values are published MurmurHash3 x86_32 test vectors, so they are an
// independent oracle for our own implementation.
describe('murmur3_32', () => {
  it.each([
    { input: '', seed: 0, expected: 0x00000000 },
    { input: '', seed: 1, expected: 0x514e28b7 },
    { input: '', seed: 0xffffffff, expected: 0x81f16f39 },
    { input: 'hello', seed: 0, expected: 0x248bfa47 },
    { input: 'Hello, world!', seed: 0, expected: 0xc0363e43 },
    { input: 'Hello, world!', seed: 1234, expected: 0xfaf6cdb3 },
    { input: 'The quick brown fox jumps over the lazy dog', seed: 0, expected: 0x2e4ff723 },
  ])('hash($input, seed=$seed) = $expected', ({ input, seed, expected }) => {
    expect(murmur3_32(input, seed)).toBe(expected);
  });

  it('defaults seed to 0', () => {
    expect(murmur3_32('hello')).toBe(murmur3_32('hello', 0));
  });

  // Pins the encoding, not the hash: the same user ID must produce the same
  // bytes in every runtime, so strings are always hashed as UTF-8.
  it('hashes strings as UTF-8 bytes', () => {
    for (const s of ['jürgen', '用户', '🚀-user']) {
      expect(murmur3_32(s)).toBe(murmur3_32Bytes(new TextEncoder().encode(s)));
    }
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = murmur3_32('negative-check');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
