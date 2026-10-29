import { describe, expect, it } from 'vitest';
import { bucketFor, pickRolloutVariant } from '../src/bucket';
import { evaluate } from '../src/evaluate';
import type { Condition, Flag, Rule, RolloutEntry, Ruleset } from '../src/types';

const makeFlag = (overrides: Partial<Flag> = {}): Flag => ({
  key: 'f',
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

const rs = (...flags: Flag[]): Ruleset => ({
  projectVersion: 1,
  flags: Object.fromEntries(flags.map((f) => [f.key, f])),
});

const pk: Condition = { attribute: 'country', op: 'eq', values: ['PK'] };
const pro: Condition = { attribute: 'plan', op: 'eq', values: ['pro'] };
const rule = (id: string, conditions: Condition[], variant: string): Rule => ({
  id,
  conditions,
  serve: { variant },
});

describe('evaluate', () => {
  it('FLAG_NOT_FOUND returns the fallback', () => {
    expect(evaluate(rs(), 'missing', {}, 'fb')).toEqual({
      variant: null,
      value: 'fb',
      reason: 'FLAG_NOT_FOUND',
    });
  });

  it('disabled flag serves offVariant', () => {
    expect(evaluate(rs(makeFlag({ enabled: false })), 'f', {}, null)).toEqual({
      variant: 'off',
      value: false,
      reason: 'OFF',
    });
  });

  it('disabled flag ignores matching rules', () => {
    const flag = makeFlag({ enabled: false, rules: [rule('r1', [pk], 'on')] });
    expect(evaluate(rs(flag), 'f', { country: 'PK' }, null).reason).toBe('OFF');
  });

  it('first matching rule wins', () => {
    const flag = makeFlag({ rules: [rule('r1', [pk], 'on'), rule('r2', [pk], 'off')] });
    expect(evaluate(rs(flag), 'f', { country: 'PK' }, null)).toEqual({
      variant: 'on',
      value: true,
      reason: 'RULE_MATCH',
      ruleId: 'r1',
    });
  });

  it('all conditions of a rule must match (AND)', () => {
    const flag = makeFlag({ rules: [rule('r1', [pk, pro], 'off')] });
    expect(evaluate(rs(flag), 'f', { country: 'PK', plan: 'free' }, null).reason).toBe('DEFAULT');
  });

  it('rule with no conditions matches everyone', () => {
    const flag = makeFlag({ rules: [rule('r1', [], 'off')] });
    expect(evaluate(rs(flag), 'f', {}, null)).toMatchObject({
      variant: 'off',
      reason: 'RULE_MATCH',
    });
  });

  it('no matching rule serves defaultServe', () => {
    const flag = makeFlag({ rules: [rule('r1', [pk], 'off')] });
    const result = evaluate(rs(flag), 'f', { country: 'US' }, null);
    expect(result).toEqual({ variant: 'on', value: true, reason: 'DEFAULT' });
    expect(result).not.toHaveProperty('ruleId');
  });

  const half: RolloutEntry[] = [
    { variant: 'on', weight: 5000 },
    { variant: 'off', weight: 5000 },
  ];

  it('rollout uses bucketFor(salt, userId)', () => {
    const flag = makeFlag({ defaultServe: { rollout: half } });
    const expected = pickRolloutVariant(half, bucketFor('s', 'u1'));
    expect(evaluate(rs(flag), 'f', { userId: 'u1' }, null).variant).toBe(expected);
  });

  it('rollout honours bucketBy', () => {
    const flag = makeFlag({ defaultServe: { rollout: half, bucketBy: 'orgId' } });
    const expected = pickRolloutVariant(half, bucketFor('s', 'org-9'));
    expect(evaluate(rs(flag), 'f', { userId: 'u1', orgId: 'org-9' }, null).variant).toBe(expected);
  });

  it('missing bucket attribute uses bucket 0', () => {
    const rollout = [
      { variant: 'off', weight: 1 },
      { variant: 'on', weight: 9999 },
    ];
    const flag = makeFlag({ defaultServe: { rollout } });
    expect(evaluate(rs(flag), 'f', {}, null).variant).toBe('off');
  });

  it('multivariate value is returned', () => {
    const flag = makeFlag({
      variants: [
        { key: 'blue', value: '#00f' },
        { key: 'green', value: '#0f0' },
        { key: 'red', value: '#f00' },
      ],
      offVariant: 'blue',
      defaultServe: { variant: 'green' },
    });
    expect(evaluate(rs(flag), 'f', {}, null)).toEqual({
      variant: 'green',
      value: '#0f0',
      reason: 'DEFAULT',
    });
  });

  describe('ERROR', () => {
    const error = { variant: null, value: 'fb', reason: 'ERROR' };

    it('serve references unknown variant', () => {
      const flag = makeFlag({ defaultServe: { variant: 'nope' } });
      expect(evaluate(rs(flag), 'f', {}, 'fb')).toEqual(error);
    });

    it('rollout weights sum below 10000 and bucket uncovered', () => {
      const rollout = [{ variant: 'on', weight: 5000 }];
      // Find a user whose bucket falls past the 5000 the rollout covers.
      const candidates = Array.from({ length: 100 }, (_, i) => `u${i}`);
      const userId = candidates.find((id) => bucketFor('s', id) >= 5000)!;
      const flag = makeFlag({ defaultServe: { rollout } });
      expect(evaluate(rs(flag), 'f', { userId }, 'fb')).toEqual(error);
    });

    it('empty rollout', () => {
      const flag = makeFlag({ defaultServe: { rollout: [] } });
      expect(evaluate(rs(flag), 'f', { userId: 'u1' }, 'fb')).toEqual(error);
    });

    it('offVariant unknown', () => {
      const flag = makeFlag({ enabled: false, offVariant: 'nope' });
      expect(evaluate(rs(flag), 'f', {}, 'fb')).toEqual(error);
    });
  });
});
