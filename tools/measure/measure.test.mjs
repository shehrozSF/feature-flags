import { describe, expect, it } from 'vitest';
import { parseArgs, percentile, summarize } from './lib.mjs';

// The measurement scripts run against production by hand; what can be unit-tested
// is the arithmetic and the argument handling, so the numbers they print are right.
describe('percentile (nearest rank)', () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5]; // order must not matter

  it('p50 and p95 of 1..10', () => {
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
  });

  it('p0 is the minimum and p100 the maximum', () => {
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 100)).toBe(10);
  });

  it('rounds the rank up, never to the nearest: p90 of 7 values is the 7th', () => {
    // 0.9 * 7 = 6.3: rounding would give the 6th value and understate the tail.
    expect(percentile([1, 2, 3, 4, 5, 6, 7], 90)).toBe(7);
  });

  it('one value is every percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("does not reorder the caller's array", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it('no values is an error, not NaN in a README', () => {
    expect(() => percentile([], 50)).toThrow(/no samples/);
  });
});

describe('summarize', () => {
  it('reports count, p50, p95, max and mean, rounded to whole ms', () => {
    expect(summarize([100.4, 200.6, 300.2, 400.9])).toEqual({
      n: 4,
      p50: 201,
      p95: 401,
      max: 401,
      mean: 251,
    });
  });
});

describe('parseArgs', () => {
  it('takes the base URL and defaults', () => {
    expect(parseArgs(['https://api.example/'], { samples: 30, sockets: 10 })).toEqual({
      base: 'https://api.example',
      samples: 30,
      sockets: 10,
    });
  });

  it('numbers can be overridden', () => {
    expect(
      parseArgs(['https://api.example', '--samples', '5', '--sockets', '2'], {
        samples: 30,
        sockets: 10,
      }),
    ).toMatchObject({ samples: 5, sockets: 2 });
  });

  it.each([
    [[], 'no base URL'],
    [['https://a', '--samples'], 'a flag without a value'],
    [['https://a', '--samples', 'lots'], 'not a number'],
    [['https://a', '--samples', '0'], 'zero'],
    [['https://a', '--nope', '1'], 'an unknown flag'],
    [['https://a', '--sockets', '1'], 'a flag this script does not take'],
  ])('%j is a usage error (%s)', (argv) => {
    expect(parseArgs(argv, { samples: 30 }).bad).toBeTruthy();
  });
});
