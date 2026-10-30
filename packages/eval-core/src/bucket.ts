import { murmur3_32 } from './murmur3';
import type { AttributeValue, RolloutEntry } from './types';

export const BUCKET_COUNT = 10000;

/**
 * Stable bucket in [0, 9999] for a value under a flag's salt (spec §5.4).
 * A missing value goes to bucket 0 (ADR 0022).
 */
export function bucketFor(salt: string, value: AttributeValue | undefined): number {
  if (value === undefined) return 0;
  return murmur3_32(`${salt}.${String(value)}`, 0) % BUCKET_COUNT;
}

const isValidWeight = (w: unknown): w is number =>
  typeof w === 'number' && Number.isInteger(w) && w >= 0;

/**
 * Variants own contiguous bucket ranges in listed order, so growing a variant
 * at the expense of the next one never moves its existing users.
 * Returns null for a malformed rollout (weights not non-negative integers
 * summing to exactly 10000), so it fails the same way for every user.
 */
export function pickRolloutVariant(rollout: RolloutEntry[], bucket: number): string | null {
  if (!Array.isArray(rollout) || !rollout.every((e) => isValidWeight(e.weight))) return null;
  if (rollout.reduce((sum, e) => sum + e.weight, 0) !== BUCKET_COUNT) return null;

  let cumulative = 0;
  for (const entry of rollout) {
    cumulative += entry.weight;
    if (bucket < cumulative) return entry.variant;
  }
  return null;
}
