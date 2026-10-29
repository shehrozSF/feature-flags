// Regenerates test/fixtures/buckets.json. The fixture pins today's bucket
// assignments: if it ever needs regenerating, every user's rollout group has
// changed, so do it deliberately and say why in the commit message.
import { writeFileSync } from 'node:fs';
import { bucketFor } from '../src/bucket';

const salts = ['', 'a.b', 'flag-salt-1', 'x'.repeat(64), 'Zt7w9xQk'];

const ids: (string | number)[] = [
  '',
  'user-1',
  'user-2',
  'user-42',
  'alice',
  'Bob',
  'jürgen',
  '用户',
  '🚀-user',
  'with.dot',
  'with space',
  'quote"s',
  0,
  12345,
  2 ** 31,
  '12345',
  ...Array.from({ length: 24 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
];

const fixture = salts.flatMap((salt) =>
  ids.map((id) => ({ salt, id, bucket: bucketFor(salt, id) })),
);

const out = new URL('../test/fixtures/buckets.json', import.meta.url);
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${fixture.length} entries to ${out.pathname}`);
