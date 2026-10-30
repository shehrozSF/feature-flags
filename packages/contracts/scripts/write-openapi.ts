// Writes openapi.json from the zod schemas. With --check, exits 1 instead of
// writing when the committed file is out of date (used in CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/openapi';

const file = new URL('../openapi.json', import.meta.url);
const next = JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // missing file counts as out of date
  }
  if (current !== next) {
    console.error('openapi.json is out of date — run: pnpm --filter @ff/contracts openapi:write');
    process.exit(1);
  }
  console.log('openapi.json is up to date');
} else {
  writeFileSync(file, next);
  console.log('wrote openapi.json');
}
