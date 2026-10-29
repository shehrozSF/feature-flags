import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import type { Context, Reason, Ruleset } from '../src/types';
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

  // A cheap fuzzer: hostile garbage in place of a ruleset or context must still
  // produce a Result, because SDKs may receive corrupted data off the network.
  it('totality on garbage: never throws', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), fc.anything(), (ruleset, key, context) => {
        const result = evaluate(ruleset as Ruleset, key, context as Context, null);
        expect(REASONS).toContain(result.reason);
      }),
    );
  });
});
