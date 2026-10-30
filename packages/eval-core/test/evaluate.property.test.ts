import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { matchCondition } from '../src/operators';
import type { Condition, Context, Flag, Reason, RolloutEntry, Ruleset } from '../src/types';
import { arbContext, arbFlag, arbRuleset } from './arbitraries';

const REASONS: Reason[] = ['OFF', 'RULE_MATCH', 'DEFAULT', 'FLAG_NOT_FOUND', 'ERROR'];

describe('evaluate properties', () => {
  it('totality: never throws and always returns a Result for valid rulesets', () => {
    fc.assert(
      fc.property(
        arbRuleset().chain((ruleset) =>
          fc.tuple(
            fc.constant(ruleset),
            fc.oneof(fc.constantFrom('', ...Object.keys(ruleset.flags)), fc.string()),
          ),
        ),
        arbContext(),
        ([ruleset, key], context) => {
          expect(REASONS).toContain(evaluate(ruleset, key, context, null).reason);
        },
      ),
    );
  });

  it('valid rulesets never produce ERROR', () => {
    fc.assert(
      fc.property(arbFlag(), arbContext(), (flag, context) => {
        const ruleset: Ruleset = { projectVersion: 1, flags: { [flag.key]: flag } };
        expect(evaluate(ruleset, flag.key, context, null).reason).not.toBe('ERROR');
      }),
    );
  });

  it('determinism: same inputs give the same result', () => {
    fc.assert(
      fc.property(arbFlag(), arbContext(), (flag, context) => {
        const ruleset: Ruleset = { projectVersion: 1, flags: { [flag.key]: flag } };
        expect(evaluate(ruleset, flag.key, context, null)).toEqual(
          evaluate(ruleset, flag.key, context, null),
        );
      }),
    );
  });

  it('served variant belongs to the flag and carries its value', () => {
    fc.assert(
      fc.property(arbFlag(), arbContext(), (flag, context) => {
        const ruleset: Ruleset = { projectVersion: 1, flags: { [flag.key]: flag } };
        const result = evaluate(ruleset, flag.key, context, null);
        if (result.variant !== null) {
          const variant = flag.variants.find((v) => v.key === result.variant);
          expect(variant).toBeDefined();
          expect(result.value).toEqual(variant!.value);
        }
      }),
    );
  });

  it('a disabled flag always serves its off variant', () => {
    fc.assert(
      fc.property(arbFlag(), arbContext(), (flag, context) => {
        const off = { ...flag, enabled: false };
        const result = evaluate(
          { projectVersion: 1, flags: { [off.key]: off } },
          off.key,
          context,
          null,
        );
        expect(result).toEqual({
          variant: off.offVariant,
          value: off.variants.find((v) => v.key === off.offVariant)!.value,
          reason: 'OFF',
        });
      }),
    );
  });

  it('an empty-condition rule placed first always wins', () => {
    fc.assert(
      fc.property(arbFlag(), arbContext(), (flag, context) => {
        const catchAll = { id: 'catch-all', conditions: [], serve: { variant: flag.offVariant } };
        const f = { ...flag, enabled: true, rules: [catchAll, ...flag.rules] };
        const result = evaluate({ projectVersion: 1, flags: { [f.key]: f } }, f.key, context, null);
        expect(result).toMatchObject({ reason: 'RULE_MATCH', ruleId: 'catch-all' });
      }),
    );
  });

  // Oracle: a deliberately naive reference implementation of "first matching
  // rule wins". If evaluate() ever ignores, reorders or skips rules, the two
  // disagree. The counter checks the property really exercises rule matching.
  it('reports the first rule whose conditions all match (oracle)', () => {
    let realMatches = 0;
    const runs = 1000;
    fc.assert(
      fc.property(arbFlag(), arbContext(), fc.boolean(), fc.nat(), (flag, context, plant, pick) => {
        const f = { ...flag, enabled: true, rules: [...flag.rules] };
        // Random conditions rarely all match by chance, so in about half the
        // runs rewrite one rule to match this context via eq checks.
        const entries = Object.entries(context).filter(([, v]) => v !== undefined);
        if (plant && f.rules.length > 0 && entries.length > 0) {
          const i = pick % f.rules.length;
          const conditions = entries
            .slice(0, 2)
            .map(([attribute, v]): Condition => ({ attribute, op: 'eq', values: [v!] }));
          f.rules[i] = { ...f.rules[i]!, conditions };
        }
        const expected = f.rules.find((r) => r.conditions.every((c) => matchCondition(c, context)));
        if (expected && expected.conditions.length > 0) realMatches++;
        const result = evaluate({ projectVersion: 1, flags: { [f.key]: f } }, f.key, context, null);
        if (expected) {
          expect(result).toMatchObject({ reason: 'RULE_MATCH', ruleId: expected.id });
        } else {
          expect(result.reason).toBe('DEFAULT');
        }
      }),
      { numRuns: runs },
    );
    // At least 10% of runs must match a rule that has real conditions.
    expect(realMatches / runs).toBeGreaterThanOrEqual(0.1);
  });

  // Fuzzer: take a VALID flag and replace one part of it with garbage, so
  // evaluation gets past the first line and hits every deeper code path with
  // corrupted data — as an SDK might receive off a flaky network.
  it('totality on corrupted flags: never throws', () => {
    const corruptions: ((f: Flag, junk: unknown) => void)[] = [
      (f, j) => (f.variants = j as Flag['variants']),
      (f, j) => (f.variants[0] = j as Flag['variants'][0]),
      (f, j) => (f.offVariant = j as string),
      (f, j) => (f.enabled = j as boolean),
      (f, j) => (f.rules = j as Flag['rules']),
      (f, j) => f.rules[0] && (f.rules[0] = j as Flag['rules'][0]),
      (f, j) => f.rules[0] && (f.rules[0].conditions = j as Flag['rules'][0]['conditions']),
      (f, j) => f.rules[0]?.conditions[0] && (f.rules[0].conditions[0] = j as Condition),
      (f, j) => f.rules[0] && (f.rules[0].serve = j as Flag['defaultServe']),
      (f, j) => (f.defaultServe = j as Flag['defaultServe']),
      (f, j) => 'rollout' in f.defaultServe && (f.defaultServe.rollout = j as RolloutEntry[]),
      (f, j) =>
        'rollout' in f.defaultServe &&
        f.defaultServe.rollout[0] &&
        (f.defaultServe.rollout[0] = j as RolloutEntry),
      (f, j) => (f.salt = j as string),
    ];
    fc.assert(
      fc.property(
        arbFlag(),
        fc.nat(corruptions.length - 1),
        fc.anything(),
        fc.oneof(
          arbContext(),
          fc.anything().map((c) => c as Context),
        ),
        (flag, which, junk, context) => {
          const broken = JSON.parse(JSON.stringify(flag)) as Flag;
          corruptions[which]!(broken, junk);
          const ruleset = { projectVersion: 1, flags: { [broken.key]: broken } };
          expect(REASONS).toContain(evaluate(ruleset, broken.key, context, null).reason);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('totality on garbage: a non-object ruleset never throws', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), fc.anything(), (ruleset, key, context) => {
        const result = evaluate(ruleset as Ruleset, key, context as Context, null);
        expect(REASONS).toContain(result.reason);
      }),
    );
  });
});
