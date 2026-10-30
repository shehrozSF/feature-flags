// Gives each test file its own freshly migrated database inside the shared
// container, so files can run in parallel without seeing each other's data.
import pg from 'pg';
import { inject } from 'vitest';
import { loadMigrations } from '../../src/adapters/node/migrations';
import { migrate } from '../../src/repo/migrate';

export async function createTestDatabase(options: { migrate?: boolean } = {}) {
  const adminUrl = inject('pgUrl');
  const name = `test_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  if (options.migrate !== false) await migrate(pool, await loadMigrations());

  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
