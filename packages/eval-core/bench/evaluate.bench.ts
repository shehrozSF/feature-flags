import { test } from 'vitest';
import { bucketFor } from '../src/bucket';
import { evaluate } from '../src/evaluate';
import type { Context, Flag, Ruleset } from '../src/types';

// Each benchmark writes its result to <package>/$BENCH_OUT/<name>.json (default
// .bench-results) so CI can compare a PR with main measured on the same machine
// (tools/bench-check). Vitest requires the path to stay inside the package.
const outDir = process.env.BENCH_OUT ?? '.bench-results';

// Rulesets and contexts are built once, outside the measured functions. Contexts
// rotate through 1,000 users so we don't benchmark one cached input.
const users: Context[] = Array.from({ length: 1000 }, (_, i) => ({
  userId: `user-${i}`,
  country: i % 2 ? 'PK' : 'US',
  plan: 'free',
}));
let i = 0;
const nextUser = () => users[i++ % users.length]!;

const base: Omit<Flag, 'key'> = {
  enabled: true,
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariant: 'off',
  rules: [],
  defaultServe: { variant: 'on' },
  salt: 'bench-salt',
  version: 1,
};

const ruleset: Ruleset = {
  projectVersion: 1,
  flags: {
    simple: { ...base, key: 'simple' },
    rules: {
      ...base,
      key: 'rules',
      rules: [
        ...['GB', 'DE', 'FR', 'IN'].map((c, n) => ({
          id: `r${n}`,
          conditions: [{ attribute: 'country', op: 'eq' as const, values: [c] }],
          serve: { variant: 'off' },
        })),
        {
          id: 'r4',
          conditions: [{ attribute: 'plan', op: 'eq' as const, values: ['free'] }],
          serve: { variant: 'on' },
        },
      ],
    },
    rollout: {
      ...base,
      key: 'rollout',
      variants: [
        { key: 'blue', value: 'blue' },
        { key: 'green', value: 'green' },
        { key: 'red', value: 'red' },
      ],
      offVariant: 'blue',
      defaultServe: {
        rollout: [
          { variant: 'blue', weight: 3400 },
          { variant: 'green', weight: 3300 },
          { variant: 'red', weight: 3300 },
        ],
      },
    },
  },
};

const cases: [name: string, fn: () => void][] = [
  ['bucketFor', () => bucketFor('bench-salt', nextUser().userId)],
  ['evaluate-boolean-no-rules', () => evaluate(ruleset, 'simple', nextUser(), false)],
  ['evaluate-5-rules-last-matches', () => evaluate(ruleset, 'rules', nextUser(), false)],
  ['evaluate-3-variant-rollout', () => evaluate(ruleset, 'rollout', nextUser(), 'blue')],
];

test('eval-core', async ({ bench }) => {
  await bench.compare(
    ...cases.map(([name, fn]) => bench(name, { writeResult: `${outDir}/${name}.json` }, fn)),
  );
});
