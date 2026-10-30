import { describe, expect, it } from 'vitest';
import {
  ContextSchema,
  EvaluateRequestSchema,
  FlagInputSchema,
  FlagPatchSchema,
  toFieldErrors,
} from '../src/index';

// A valid flag shaped like the seeded `pk-local-payments` flag (spec §9.4).
const valid = {
  key: 'pk-local-payments',
  name: 'PK local payments',
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [
    {
      id: 'r1',
      conditions: [{ attribute: 'country', op: 'in', values: ['PK'] }],
      serve: { variant: 'on' },
    },
  ],
  defaultServe: {
    rollout: [
      { variant: 'on', weight: 1000 },
      { variant: 'off', weight: 9000 },
    ],
  },
};

const errorPaths = (input: unknown): string[] => {
  const result = FlagInputSchema.safeParse(input);
  return result.success ? [] : toFieldErrors(result.error).map((e) => e.path);
};

describe('FlagInputSchema', () => {
  it('accepts a valid flag', () => {
    expect(errorPaths(valid)).toEqual([]);
  });

  const variants = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `v${i}`, value: i }));
  const rules = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      conditions: [],
      serve: { variant: 'on' },
    }));
  const conditions = (n: number) =>
    Array.from({ length: n }, () => ({ attribute: 'country', op: 'eq', values: ['PK'] }));

  it.each([
    { name: 'key with uppercase and underscore', change: { key: 'Bad_Key' }, path: 'key' },
    {
      name: 'duplicate variant key',
      change: {
        variants: [
          { key: 'on', value: 1 },
          { key: 'on', value: 2 },
          { key: 'off', value: 3 },
        ],
      },
      path: 'variants.1.key',
    },
    { name: 'unknown offVariant', change: { offVariant: 'nope' }, path: 'offVariant' },
    {
      name: 'rule serves unknown variant',
      change: { rules: [{ id: 'r1', conditions: [], serve: { variant: 'nope' } }] },
      path: 'rules.0.serve.variant',
    },
    {
      name: 'weights not summing to 10000',
      change: {
        defaultServe: {
          rollout: [
            { variant: 'on', weight: 5000 },
            { variant: 'off', weight: 4000 },
          ],
        },
      },
      path: 'defaultServe.rollout',
    },
    {
      name: 'negative weight',
      change: {
        defaultServe: {
          rollout: [
            { variant: 'on', weight: -1 },
            { variant: 'off', weight: 10001 },
          ],
        },
      },
      path: 'defaultServe.rollout.0.weight',
    },
    {
      name: '11 variants',
      change: {
        variants: variants(11),
        offVariant: 'v0',
        rules: [],
        defaultServe: { variant: 'v0' },
      },
      path: 'variants',
    },
    { name: '21 rules', change: { rules: rules(21) }, path: 'rules' },
    {
      name: '11 conditions in a rule',
      change: { rules: [{ id: 'r1', conditions: conditions(11), serve: { variant: 'on' } }] },
      path: 'rules.0.conditions',
    },
    {
      name: 'rules JSON over 32 KB',
      change: {
        rules: [
          {
            id: 'r1',
            conditions: [
              {
                attribute: 'email',
                op: 'in',
                values: Array.from({ length: 2000 }, (_, i) => `user${i}@example.com`),
              },
            ],
            serve: { variant: 'on' },
          },
        ],
      },
      path: 'rules',
    },
    {
      name: 'unknown operator',
      change: {
        rules: [
          {
            id: 'r1',
            conditions: [{ attribute: 'a', op: 'regex', values: ['x'] }],
            serve: { variant: 'on' },
          },
        ],
      },
      path: 'rules.0.conditions.0.op',
    },
  ])('rejects $name at "$path"', ({ change, path }) => {
    expect(errorPaths({ ...valid, ...change })).toContain(path);
  });
});

describe('ContextSchema', () => {
  it('accepts flat string/number/boolean values', () => {
    expect(ContextSchema.safeParse({ userId: 'u', beta: true, age: 3 }).success).toBe(true);
  });

  it.each([
    { name: 'an array', value: ['u'] },
    { name: 'a nested object', value: { user: { id: 'u' } } },
    {
      name: '51 keys',
      value: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])),
    },
  ])('rejects $name', ({ value }) => {
    expect(ContextSchema.safeParse(value).success).toBe(false);
  });
});

describe('FlagPatchSchema', () => {
  it('accepts a single field', () => {
    expect(FlagPatchSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(FlagPatchSchema.safeParse({}).success).toBe(false);
  });

  it('rejects changing the key', () => {
    expect(FlagPatchSchema.safeParse({ key: 'other' }).success).toBe(false);
  });
});

describe('EvaluateRequestSchema', () => {
  it('requires a context', () => {
    const result = EvaluateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.success ? [] : toFieldErrors(result.error).map((e) => e.path)).toContain(
      'context',
    );
  });
});
