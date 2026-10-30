// `pnpm --filter @ff/api migrate`: applies pending migrations to DATABASE_URL.
import pg from 'pg';
import { migrate } from '../../repo/migrate';
import { loadMigrations } from './migrations';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Set DATABASE_URL, e.g. postgres://ff:ff@localhost:5432/ff (see docker-compose.yml)',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const applied = await migrate(pool, await loadMigrations());
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} finally {
  await pool.end();
}
