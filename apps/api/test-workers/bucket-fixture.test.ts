import { bucketFor } from '@ff/eval-core';
import { describe, expect, it } from 'vitest';
import fixture from '../../../packages/eval-core/test/fixtures/buckets.json';

// The same golden file as eval-core's Node test, run again inside workerd: the
// SDKs and the Worker must put every user in the same bucket.
describe('bucket fixture in workerd', () => {
  it('runs inside workerd', () => {
    // Proves this file isn't silently running in Node.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it.each(fixture)('$salt / $id → $bucket', ({ salt, id, bucket }) => {
    expect(bucketFor(salt, id)).toBe(bucket);
  });
});
