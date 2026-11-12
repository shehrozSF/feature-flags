import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeRollout, isSplit, percentOf, serveShares } from '../src/rollout';
import type { Flag } from '../src/types';
import { arbFlag } from './arbitraries';

const flag = (overrides: Partial<Flag> = {}): Flag => ({
  key: 'checkout-v2',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [],
  defaultServe: { variant: 'on' },
  salt: 's',
  version: 1,
  ...overrides,
});

const quarter = {
  rollout: [
    { variant: 'on', weight: 2500 },
    { variant: 'off', weight: 7500 },
  ],
};

describe('percentOf', () => {
  it.each([
    [10000, 100],
    [2500, 25],
    [1, 0.01], // the finest step weights allow
    [3333, 33.33],
    [0, 0],
  ])('%i basis points is %d%%', (bp, pct) => {
    expect(percentOf(bp)).toBe(pct);
  });
});

describe('serveShares', () => {
  it('a single variant is 100% of it', () => {
    expect(serveShares({ variant: 'on' })).toEqual([{ variant: 'on', percent: 100 }]);
  });

  it('a rollout keeps its listed order', () => {
    expect(serveShares(quarter)).toEqual([
      { variant: 'on', percent: 25 },
      { variant: 'off', percent: 75 },
    ]);
  });
});

describe('isSplit', () => {
  it('a share strictly between 0 and 100 splits users', () => {
    expect(isSplit(serveShares(quarter))).toBe(true);
  });

  it('100/0 is not a split: everyone gets the same variant', () => {
    const allOn = {
      rollout: [
        { variant: 'on', weight: 10000 },
        { variant: 'off', weight: 0 },
      ],
    };
    expect(isSplit(serveShares(allOn))).toBe(false);
    expect(isSplit(serveShares({ variant: 'on' }))).toBe(false);
  });

  it('an empty rollout is not a split', () => {
    expect(isSplit([])).toBe(false);
  });
});

describe('describeRollout', () => {
  it('a flag with no rules: "everyone"', () => {
    const summary = describeRollout(flag({ defaultServe: quarter }));
    expect(summary).toEqual({
      enabled: true,
      offVariant: 'off',
      rules: [],
      defaultShares: [
        { variant: 'on', percent: 25 },
        { variant: 'off', percent: 75 },
      ],
      splitting: true,
      text: 'everyone: on 25%, off 75%',
    });
  });

  it('rules come first, in order, then "everyone else"', () => {
    const summary = describeRollout(
      flag({
        rules: [
          { id: 'beta', conditions: [], serve: { variant: 'on' } },
          { id: 'pk', conditions: [], serve: quarter },
        ],
        defaultServe: { variant: 'off' },
      }),
    );
    expect(summary.rules.map((r) => r.ruleId)).toEqual(['beta', 'pk']);
    expect(summary.text).toBe(
      'rule beta: on 100% · rule pk: on 25%, off 75% · everyone else: off 100%',
    );
    // Only a rule splits users, and that still counts as a rollout in progress.
    expect(summary.splitting).toBe(true);
  });

  it('an off flag says what everyone gets, and is never "splitting"', () => {
    const summary = describeRollout(flag({ enabled: false, defaultServe: quarter }));
    expect(summary.text).toBe('off: everyone gets off');
    expect(summary.splitting).toBe(false);
    // The shares are still there: they show what turning it on would do.
    expect(summary.defaultShares).toHaveLength(2);
  });

  it('an empty rollout reads as "nothing"', () => {
    expect(describeRollout(flag({ defaultServe: { rollout: [] } })).text).toBe('everyone: nothing');
  });
});

// The same claims for any valid flag (weights summing to 10000; see arbitraries.ts).
describe('describeRollout properties', () => {
  it('every serve shares out exactly 100%', () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        const s = describeRollout(f);
        for (const shares of [s.defaultShares, ...s.rules.map((r) => r.shares)]) {
          // Rounded: 0.01-steps don't add up exactly in floating point.
          const total = shares.reduce((sum, x) => sum + x.percent, 0);
          expect(Math.round(total * 100)).toBe(10000);
        }
      }),
    );
  });

  it('percentages convert back to the exact stored weights', () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        const s = describeRollout(f);
        if ('rollout' in f.defaultServe) {
          expect(s.defaultShares.map((x) => Math.round(x.percent * 100))).toEqual(
            f.defaultServe.rollout.map((r) => r.weight),
          );
        }
      }),
    );
  });

  it('splitting means: on, and some serve has a weight strictly between 0 and 10000', () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        const serves = [f.defaultServe, ...f.rules.map((r) => r.serve)];
        const expected =
          f.enabled &&
          serves.some(
            (sv) => 'rollout' in sv && sv.rollout.some((r) => r.weight > 0 && r.weight < 10000),
          );
        expect(describeRollout(f).splitting).toBe(expected);
      }),
    );
  });

  it('one rule line per rule, in order', () => {
    fc.assert(
      fc.property(arbFlag(), (f) => {
        expect(describeRollout(f).rules.map((r) => r.ruleId)).toEqual(f.rules.map((r) => r.id));
      }),
    );
  });
});
