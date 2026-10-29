import { describe, expect, it } from 'vitest';
import { bucketFor } from '../../src/bucket';
import fixture from '../fixtures/buckets.json';

// Golden file: every runtime (Node now, workerd in Phase 3, Firefox in M2) and
// every future version must reproduce these exact buckets.
describe('bucket fixture', () => {
  it.each(fixture)('$salt / $id → $bucket', ({ salt, id, bucket }) => {
    expect(bucketFor(salt, id)).toBe(bucket);
  });
});
