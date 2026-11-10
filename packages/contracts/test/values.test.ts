import type { JsonValue } from '@ff/eval-core';
import { describe, expect, it } from 'vitest';
import { sameJsonType } from '../src/index';

// SDKs return the caller's fallback when a flag's value has a different JSON type
// (asking for a boolean and getting "blue" is a bug, not a value to use).
describe('sameJsonType', () => {
  it('is true for values of the same JSON type', () => {
    const pairs: [JsonValue, JsonValue][] = [
      [null, null],
      [[], [1]],
      [{}, { a: 1 }],
      ['a', 'b'],
      [1, 2.5],
      [true, false],
    ];
    for (const [a, b] of pairs) expect(sameJsonType(a, b), JSON.stringify([a, b])).toBe(true);
  });

  it('is false across types', () => {
    const pairs: [JsonValue, JsonValue][] = [
      [null, {}],
      [[], {}],
      ['1', 1],
      [0, false],
      [null, false],
    ];
    for (const [a, b] of pairs) expect(sameJsonType(a, b), JSON.stringify([a, b])).toBe(false);
  });
});
