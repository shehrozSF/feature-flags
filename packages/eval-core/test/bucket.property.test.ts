import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketFor, pickRolloutVariant } from '../src/bucket';
import type { RolloutEntry } from '../src/types';

// One fixed population of 100k user IDs. The seed makes it identical on every
// run, so a failure here is reproducible rather than a fluke.
const N = 100_000;
const ids = fc.sample(fc.uuid(), { numRuns: N, seed: 42 });

/** 2–4 integer weights summing to exactly 10000, built from random cut points. */
const arbWeights = fc
  .uniqueArray(fc.integer({ min: 1, max: BUCKET_COUNT - 1 }), { minLength: 1, maxLength: 3 })
  .map((cuts) => {
    const points = [0, ...cuts.sort((a, b) => a - b), BUCKET_COUNT];
    return points.slice(1).map((p, i) => p - points[i]!);
  });

const toRollout = (weights: number[]): RolloutEntry[] =>
  weights.map((weight, i) => ({ variant: `v${i}`, weight }));

describe('bucketing properties', () => {
  it('determinism: the same salt and id always give the same bucket', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (salt, id) => {
        expect(bucketFor(salt, id)).toBe(bucketFor(salt, id));
      }),
    );
  });

  it('range: every bucket is an integer in [0, 9999]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (salt, id) => {
        const b = bucketFor(salt, id);
        expect(Number.isInteger(b)).toBe(true);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(BUCKET_COUNT);
      }),
    );
  });

  it('distribution: each variant gets its weight ±1 percentage point', () => {
    fc.assert(
      fc.property(arbWeights, fc.string(), (weights, salt) => {
        const rollout = toRollout(weights);
        const counts = new Map<string, number>();
        for (const id of ids) {
          const v = pickRolloutVariant(rollout, bucketFor(salt, id))!;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        rollout.forEach(({ variant, weight }) => {
          const share = (counts.get(variant) ?? 0) / N;
          expect(Math.abs(share - weight / BUCKET_COUNT)).toBeLessThanOrEqual(0.01);
        });
      }),
      { numRuns: 20 },
    );
  });

  it('stickiness: moving weight from variant k+1 to variant k never moves users out of k', () => {
    const sample = ids.slice(0, 10_000);
    fc.assert(
      fc.property(
        arbWeights.filter((w) => w.length >= 2),
        fc.string(),
        fc.nat(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (weights, salt, kSeed, fraction) => {
          const k = kSeed % (weights.length - 1);
          const delta = Math.max(1, Math.floor(weights[k + 1]! * fraction));
          const after = [...weights];
          after[k]! += delta;
          after[k + 1]! -= delta;
          const before = toRollout(weights);
          const grown = toRollout(after);
          for (const id of sample) {
            const b = bucketFor(salt, id);
            if (pickRolloutVariant(before, b) === `v${k}`) {
              expect(pickRolloutVariant(grown, b)).toBe(`v${k}`);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('independence: two flags with different salts overlap like independent coin flips', () => {
    const half: RolloutEntry[] = [
      { variant: 'on', weight: 5000 },
      { variant: 'off', weight: 5000 },
    ];
    fc.assert(
      fc.property(fc.string(), fc.string(), (saltA, saltB) => {
        fc.pre(saltA !== saltB);
        let both = 0;
        for (const id of ids) {
          if (
            pickRolloutVariant(half, bucketFor(saltA, id)) === 'on' &&
            pickRolloutVariant(half, bucketFor(saltB, id)) === 'on'
          ) {
            both++;
          }
        }
        expect(Math.abs(both / N - 0.25)).toBeLessThanOrEqual(0.01);
      }),
      { numRuns: 10 },
    );
  });
});
