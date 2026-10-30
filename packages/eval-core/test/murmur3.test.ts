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

  // Byte-level vectors covering the cases above misses: a 2-byte tail, an input
  // that is exactly one 4-byte block, bytes >= 0x80, and multi-byte UTF-8.
  it.each([
    { bytes: [0x21, 0x43], seed: 0, expected: 0xa0f7b07a },
    { bytes: [0xff, 0xff, 0xff, 0xff], seed: 0, expected: 0x76293b50 },
    { bytes: [0x61, 0x61, 0x61, 0x61], seed: 0x9747b28c, expected: 0x5a97808a },
  ])('bytes $bytes, seed=$seed = $expected', ({ bytes, seed, expected }) => {
    expect(murmur3_32Bytes(new Uint8Array(bytes), seed)).toBe(expected);
  });

  it('hashes multi-byte UTF-8 correctly', () => {
    expect(murmur3_32('ππππππππ', 0x9747b28c)).toBe(0xd58063c1);
  });

  it('defaults seed to 0', () => {
    expect(murmur3_32('hello')).toBe(murmur3_32('hello', 0));
  });

  // Pins the encoding, not the hash: the same user ID must produce the same
  // bytes in every runtime, so strings are always hashed as UTF-8.
  // The bytes are written out by hand, so this checks the encoding independently.
  it.each([
    { s: 'jürgen', utf8: [0x6a, 0xc3, 0xbc, 0x72, 0x67, 0x65, 0x6e] },
    { s: '用户', utf8: [0xe7, 0x94, 0xa8, 0xe6, 0x88, 0xb7] },
    { s: '🚀-user', utf8: [0xf0, 0x9f, 0x9a, 0x80, 0x2d, 0x75, 0x73, 0x65, 0x72] },
  ])('hashes $s as its UTF-8 bytes', ({ s, utf8 }) => {
    expect(murmur3_32(s)).toBe(murmur3_32Bytes(new Uint8Array(utf8)));
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = murmur3_32('negative-check');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
