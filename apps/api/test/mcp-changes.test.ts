import type { FlagResource } from '@ff/contracts';
import type { RolloutEntry } from '@ff/eval-core';
import { describe, expect, it } from 'vitest';
import { planChange } from '../src/mcp/changes';

// planChange is pure: flag + requested change in, exact PATCH body + preview out.
const flag = (overrides: Partial<FlagResource> = {}): FlagResource => ({
  key: 'checkout-v2',
  name: 'Checkout v2',
  description: '',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [],
  defaultServe: { variant: 'off' },
  salt: 's',
  version: 4,
  updatedAt: '2026-11-12T10:00:00Z',
  ...overrides,
});

const rollout = (...entries: [string, number][]) => ({
  rollout: entries.map(([variant, weight]) => ({ variant, weight })),
});

const ok = (plan: ReturnType<typeof planChange>) => {
  if (!plan.ok) throw new Error(`expected a plan, got: ${plan.message}`);
  return plan;
};
const failure = (plan: ReturnType<typeof planChange>) => {
  if (plan.ok) throw new Error('expected a refusal');
  return plan.message;
};

describe('set_enabled', () => {
  it('turning on sends only { enabled: true }', () => {
    const plan = ok(planChange(flag({ enabled: false }), { type: 'set_enabled', enabled: true }));
    expect(plan).toMatchObject({ op: 'update', body: { enabled: true } });
    expect(plan.summary).toBe(
      'Turn on "checkout-v2": off (everyone gets off); when on: everyone: off 100% → everyone: off 100%',
    );
  });

  it('turning off', () => {
    const plan = ok(planChange(flag(), { type: 'set_enabled', enabled: false }));
    expect(plan.body).toEqual({ enabled: false });
    expect(plan.summary).toMatch(/^Turn off/);
  });

  it('refuses a no-op: "already on"', () => {
    expect(failure(planChange(flag(), { type: 'set_enabled', enabled: true }))).toBe(
      '"checkout-v2" is already on; nothing to change',
    );
  });
});

describe('set_rollout for everyone else (defaultServe)', () => {
  it('from a single variant: percentages become basis points, in variant order', () => {
    const plan = ok(planChange(flag(), { type: 'set_rollout', weights: { off: 75, on: 25 } }));
    expect(plan.body).toEqual({ defaultServe: rollout(['on', 2500], ['off', 7500]) });
    expect(plan.before).toBe('everyone: off 100%');
    expect(plan.after).toBe('everyone: on 25%, off 75%');
  });

  it('keeps the existing order, so users already in "on" stay in it', () => {
    // Stored as off-then-on: on owns the top of the bucket range. Reordering would
    // move every existing "on" user; keeping the order only grows the range.
    const current = flag({ defaultServe: rollout(['off', 9000], ['on', 1000]) });
    const plan = ok(planChange(current, { type: 'set_rollout', weights: { on: 25, off: 75 } }));
    expect(plan.body).toEqual({ defaultServe: rollout(['off', 7500], ['on', 2500]) });
  });

  it('keeps bucketBy', () => {
    const current = flag({
      defaultServe: { ...rollout(['on', 1000], ['off', 9000]), bucketBy: 'orgId' },
    });
    const plan = ok(planChange(current, { type: 'set_rollout', weights: { on: 50, off: 50 } }));
    expect(plan.body).toEqual({
      defaultServe: { ...rollout(['on', 5000], ['off', 5000]), bucketBy: 'orgId' },
    });
  });

  it('an entry left out drops to 0% but keeps its place', () => {
    const three = flag({
      variants: [
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
        { key: 'c', value: 3 },
      ],
      offVariant: 'a',
      defaultServe: rollout(['a', 3000], ['b', 3000], ['c', 4000]),
    });
    const plan = ok(planChange(three, { type: 'set_rollout', weights: { a: 50, c: 50 } }));
    expect(plan.body).toEqual({ defaultServe: rollout(['a', 5000], ['b', 0], ['c', 5000]) });
  });

  it('0.01% is the finest step', () => {
    const plan = ok(planChange(flag(), { type: 'set_rollout', weights: { on: 0.01, off: 99.99 } }));
    expect(plan.body).toEqual({ defaultServe: rollout(['on', 1], ['off', 9999]) });
  });

  it('an off flag still previews what changes for when it is on', () => {
    const plan = ok(
      planChange(flag({ enabled: false }), { type: 'set_rollout', weights: { on: 10, off: 90 } }),
    );
    expect(plan.before).toBe('off (everyone gets off); when on: everyone: off 100%');
    expect(plan.after).toBe('off (everyone gets off); when on: everyone: on 10%, off 90%');
  });
});

describe('set_rollout on a rule', () => {
  const withRules = flag({
    rules: [
      {
        id: 'beta',
        conditions: [{ attribute: 'beta', op: 'eq', values: [true] }],
        serve: { variant: 'on' },
      },
      {
        id: 'pk',
        conditions: [{ attribute: 'country', op: 'eq', values: ['PK'] }],
        serve: { variant: 'off' },
      },
    ],
  });

  it('sends every rule (PATCH replaces whole fields), changing only that one', () => {
    const plan = ok(
      planChange(withRules, { type: 'set_rollout', ruleId: 'pk', weights: { on: 20, off: 80 } }),
    );
    expect(plan.body).toEqual({
      rules: [
        withRules.rules[0],
        { ...withRules.rules[1], serve: rollout(['on', 2000], ['off', 8000]) },
      ],
    });
    expect(plan.after).toBe(
      'rule beta: on 100% · rule pk: on 20%, off 80% · everyone else: off 100%',
    );
  });

  it('an unknown rule names the real ones', () => {
    expect(
      failure(planChange(withRules, { type: 'set_rollout', ruleId: 'nope', weights: { on: 100 } })),
    ).toBe(
      'no rule "nope" on "checkout-v2"; its rules are beta, pk (leave ruleId out for everyone else)',
    );
  });

  it('a flag without rules says so', () => {
    expect(
      failure(planChange(flag(), { type: 'set_rollout', ruleId: 'x', weights: { on: 100 } })),
    ).toContain('it has no rules');
  });
});

describe('set_rollout refusals', () => {
  it.each([
    [{ on: 25, off: 70 }, 'percentages must add up to 100, got 95'],
    [{ on: 25, maybe: 75 }, 'unknown variant(s) maybe; this flag has on, off'],
    [{ on: 25.005, off: 74.995 }, "on: 25.005% isn't a valid share (0-100, at most 2 decimals)"],
    [{ on: -5, off: 105 }, "on: -5% isn't a valid share (0-100, at most 2 decimals)"],
    [{ on: Number.NaN, off: 100 }, "on: NaN% isn't a valid share (0-100, at most 2 decimals)"],
  ])('%o → %s', (weights, message) => {
    expect(failure(planChange(flag(), { type: 'set_rollout', weights }))).toBe(message);
  });

  it('refuses a no-op, even when the stored JSON has its keys in another order', () => {
    // As Postgres JSONB returns it: "weight" (6 letters) before "variant" (7).
    const stored = flag({
      defaultServe: {
        rollout: [
          JSON.parse('{"weight":2500,"variant":"on"}') as RolloutEntry,
          JSON.parse('{"weight":7500,"variant":"off"}') as RolloutEntry,
        ],
      },
    });
    expect(failure(planChange(stored, { type: 'set_rollout', weights: { on: 25, off: 75 } }))).toBe(
      '"checkout-v2" already serves that; nothing to change',
    );
  });

  it('100% of the variant already served is still a real change: a 100/0 rollout', () => {
    // "variant: on" and "rollout on 100%" serve the same users today, but differ in
    // shape; allowed, so a later percentage change keeps the order chosen now.
    const plan = ok(
      planChange(flag({ defaultServe: { variant: 'on' } }), {
        type: 'set_rollout',
        weights: { on: 100 },
      }),
    );
    expect(plan.body).toEqual({ defaultServe: rollout(['on', 10000]) });
  });

  it("refuses when the merged flag fails the API's own checks", () => {
    // A stored flag the API would reject today (offVariant points nowhere): the
    // preview must not promise a write the API will refuse.
    const broken = flag({ offVariant: 'gone' });
    expect(
      failure(planChange(broken, { type: 'set_rollout', weights: { on: 50, off: 50 } })),
    ).toContain('offVariant');
  });
});

describe('archive', () => {
  it('has no body and says it is final', () => {
    const plan = ok(planChange(flag(), { type: 'archive' }));
    expect(plan.op).toBe('archive');
    expect(plan.body).toBeUndefined();
    // Review #4: nothing can bring it back, and its key can't be used again.
    expect(plan.summary).toBe(
      'Archive "checkout-v2". This is permanent: it stops being served, it can\'t be ' +
        'restored, and the key "checkout-v2" can never be used for a new flag.',
    );
  });
});

describe('review fixes', () => {
  it('every percentage in a preview is exact, with no floating-point noise', () => {
    const plan = ok(planChange(flag(), { type: 'set_rollout', weights: { on: 3.33, off: 96.67 } }));
    expect(plan.after).toBe('everyone: on 3.33%, off 96.67%');
  });

  // Review #9: naming a new variant at 0% serves nobody new, so it is no change.
  it('a new variant at 0% is not added, so an otherwise equal rollout is a no-op', () => {
    const three = flag({
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
        { key: 'beta', value: 'b' },
      ],
      defaultServe: rollout(['on', 2500], ['off', 7500]),
    });
    expect(
      failure(planChange(three, { type: 'set_rollout', weights: { on: 25, off: 75, beta: 0 } })),
    ).toBe('"checkout-v2" already serves that; nothing to change');
    // An existing entry at 0% keeps its place (bucket ranges stay put).
    const plan = ok(
      planChange(three, { type: 'set_rollout', weights: { on: 100, off: 0, beta: 0 } }),
    );
    expect(plan.body).toEqual({ defaultServe: rollout(['on', 10000], ['off', 0]) });
  });
});
