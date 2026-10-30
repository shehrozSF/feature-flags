import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '../src/adapters/node/migrations';
import { migrate } from '../src/repo/migrate';
import { createTestDatabase } from './helpers/db';

// These run against a real Postgres 17 in Docker (Testcontainers), so they
// check the actual SQL: constraints, cascades and transactions.
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
  pool = db.pool;
});
afterAll(() => db.drop());

const pgError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

async function newProject() {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('p') RETURNING id`,
  );
  return rows[0]!.id;
}

const flagSql = `INSERT INTO flags (project_id, key, name, variants, off_variant, default_serve, salt)
  VALUES ($1, $2, 'n', '[{"key":"on","value":true}]', 'on', '{"variant":"on"}', 's')`;

describe('migrate', () => {
  it('applies all migrations once', async () => {
    const files = await loadMigrations();
    expect(await migrate(pool, files)).toEqual([
      '0001_create_projects.sql',
      '0002_create_api_keys.sql',
      '0003_create_flags.sql',
    ]);
    expect(await migrate(pool, files)).toEqual([]);
  });

  it('creates the expected tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'api_keys',
      'flags',
      'projects',
      'schema_migrations',
    ]);
  });

  it('enforces the flag key format (check violation 23514)', async () => {
    expect(await pgError(pool.query(flagSql, [await newProject(), 'Bad_Key']))).toBe('23514');
  });

  it('enforces one key per project (unique violation 23505)', async () => {
    const project = await newProject();
    await pool.query(flagSql, [project, 'dup']);
    expect(await pgError(pool.query(flagSql, [project, 'dup']))).toBe('23505');
  });

  it('deleting a project cascades to its keys and flags', async () => {
    const project = await newProject();
    await pool.query(flagSql, [project, 'f']);
    await pool.query(
      `INSERT INTO api_keys (project_id, kind, key_hash, key_prefix) VALUES ($1, 'admin', '\x01', 'p')`,
      [project],
    );
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project]);
    const counts = await pool.query<{ keys: string; flags: string }>(
      `SELECT (SELECT count(*) FROM api_keys WHERE project_id = $1) AS keys,
              (SELECT count(*) FROM flags WHERE project_id = $1) AS flags`,
      [project],
    );
    expect(counts.rows[0]).toEqual({ keys: '0', flags: '0' });
  });

  it('a failing migration is rolled back and not recorded', async () => {
    const bad = [{ name: '9999_bad.sql', sql: 'CREATE TABLE x (id int); SELECT 1/0;' }];
    expect(await pgError(migrate(pool, bad))).toBe('22012'); // division_by_zero
    const table = await pool.query(`SELECT to_regclass('public.x') AS t`);
    expect(table.rows[0]).toEqual({ t: null });
    const recorded = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE name = '9999_bad.sql'`,
    );
    expect(recorded.rowCount).toBe(0);
  });
});
