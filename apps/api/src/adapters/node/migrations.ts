// Reads apps/api/migrations/*.sql from disk (Node only; Workers bundle them in Phase 3).
import { readdir, readFile } from 'node:fs/promises';
import type { Migration } from '../../repo/migrate';

const dir = new URL('../../../migrations/', import.meta.url);

export async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(new URL(name, dir), 'utf8') })),
  );
}
