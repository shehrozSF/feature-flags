// fast-check generators for schema-valid flags, rulesets and contexts.
// "Valid" means what Phase 2's validation will guarantee: unique variant keys,
// every reference points at an existing variant, rollout weights sum to 10000.
import fc from 'fast-check';
import { BUCKET_COUNT } from '../src/bucket';
import type {
  AttributeValue,
  Condition,
  Context,
  Flag,
  Operator,
  Ruleset,
  Serve,
} from '../src/types';

const CONTEXT_KEYS = ['userId', 'country', 'plan', 'version', 'age', 'beta'];
const OPERATORS: Operator[] = ['eq', 'in', 'contains', 'gt', 'lt', 'semverGte'];

// Conditions and contexts mostly draw from the same small pools, so generated
// rules actually match generated contexts often enough to test rule selection.
// The weight-1 random arbitraries keep the odd/edge inputs coming too.
const POOL: AttributeValue[] = ['PK', 'US', 'pro', 'free', '1.2.3', '2.0.0', 1, 5, 50, true, false];

const arbAttributeValue: fc.Arbitrary<AttributeValue> = fc.oneof(
  { arbitrary: fc.constantFrom(...POOL), weight: 8 },
  { arbitrary: fc.string(), weight: 1 },
  { arbitrary: fc.integer({ min: -100, max: 100 }), weight: 1 },
  { arbitrary: fc.double({ noNaN: false }), weight: 1 },
  { arbitrary: fc.boolean(), weight: 1 },
);

const arbAttributeName = fc.oneof(
  { arbitrary: fc.constantFrom(...CONTEXT_KEYS), weight: 9 },
  { arbitrary: fc.string(), weight: 1 },
);

/** `count` non-negative integers summing to exactly 10000 (zeros allowed). */
const arbWeightsFor = (count: number): fc.Arbitrary<number[]> =>
  fc
    .array(fc.integer({ min: 0, max: BUCKET_COUNT }), {
      minLength: count - 1,
      maxLength: count - 1,
    })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), BUCKET_COUNT];
      return points.slice(1).map((p, i) => p - points[i]!);
    });

const arbServe = (variantKeys: string[]): fc.Arbitrary<Serve> =>
  fc.oneof(
    fc.constantFrom(...variantKeys).map((variant): Serve => ({ variant })),
    fc
      .tuple(arbWeightsFor(variantKeys.length), fc.constantFrom(undefined, 'userId', 'orgId'))
      .map(([weights, bucketBy]): Serve => {
        const rollout = variantKeys.map((variant, i) => ({ variant, weight: weights[i]! }));
        return bucketBy === undefined ? { rollout } : { rollout, bucketBy };
      }),
  );

const arbCondition: fc.Arbitrary<Condition> = fc.record({
  attribute: arbAttributeName,
  op: fc.constantFrom(...OPERATORS),
  values: fc.array(arbAttributeValue, { minLength: 1, maxLength: 3 }),
});

export const arbFlag = (key: fc.Arbitrary<string> = fc.string()): fc.Arbitrary<Flag> =>
  fc
    .uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 4 })
    .chain((variantKeys) =>
      fc.record({
        key,
        enabled: fc.boolean(),
        variants: fc.constant(variantKeys.map((k, i) => ({ key: k, value: i }))),
        offVariant: fc.constantFrom(...variantKeys),
        rules: fc.array(
          fc.record({
            id: fc.uuid(),
            conditions: fc.array(arbCondition, { maxLength: 3 }),
            serve: arbServe(variantKeys),
          }),
          { maxLength: 4 },
        ),
        defaultServe: arbServe(variantKeys),
        salt: fc.string(),
        version: fc.nat(),
      }),
    );

export const arbRuleset = (): fc.Arbitrary<Ruleset> =>
  fc
    .uniqueArray(fc.string(), { maxLength: 5 })
    .chain((keys) => fc.tuple(...keys.map((k) => arbFlag(fc.constant(k)))))
    .map((flags) => ({
      projectVersion: 1,
      flags: Object.fromEntries(flags.map((f) => [f.key, f])),
    }));

// Cast: generated contexts deliberately include wrong types (e.g. a numeric
// userId) because callers outside TypeScript can send them.
export const arbContext = (): fc.Arbitrary<Context> =>
  fc
    .dictionary(fc.oneof(arbAttributeName, fc.constant('orgId')), arbAttributeValue, {
      maxKeys: 8,
    })
    .map((d) => d as Context);
