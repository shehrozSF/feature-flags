// MurmurHash3 x86_32. Implemented here (not via platform crypto) so bucketing is
// synchronous and byte-for-byte identical in Node, Workers and browsers (ADR 0007).

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const encoder = new TextEncoder();

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function mixK(k: number): number {
  k = Math.imul(k, C1);
  k = rotl32(k, 15);
  return Math.imul(k, C2);
}

export function murmur3_32Bytes(bytes: Uint8Array, seed = 0): number {
  const len = bytes.length;
  const blocks = len & ~3;
  let h = seed | 0;

  for (let i = 0; i < blocks; i += 4) {
    const k = bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24) | 0;
    h ^= mixK(k);
    h = rotl32(h, 13);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  switch (len & 3) {
    case 3:
      tail ^= bytes[blocks + 2]! << 16;
    // falls through
    case 2:
      tail ^= bytes[blocks + 1]! << 8;
    // falls through
    case 1:
      tail ^= bytes[blocks]!;
      h ^= mixK(tail);
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function murmur3_32(input: string, seed = 0): number {
  return murmur3_32Bytes(encoder.encode(input), seed);
}
