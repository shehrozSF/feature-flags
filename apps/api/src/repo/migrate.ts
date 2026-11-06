// Applies plain-SQL migrations in name order, each in its own transaction, and
// records them in schema_migrations so each runs exactly once (ADR 0012).
import type pg from 'pg';
import { holdClient } from './pg-client';

export type Migration = { name: string; sql: string };

// Any fixed number works; it just has to be the same for every runner, so two
// deploys starting at once can't apply migrations concurrently.
const LOCK_ID = 727274;

export async function migrate(pool: pg.Pool, migrations: Migration[]): Promise<string[]> {
  return holdClient(pool, async (client, rollback) => {
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const done = new Set(rows.map((r) => r.name));

      const applied: string[] = [];
      for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
        if (done.has(m.name)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
          await client.query('COMMIT');
        } catch (error) {
          await rollback();
          throw error;
        }
        applied.push(m.name);
      }
      return applied;
    } finally {
      // On a dead connection this fails too, but Postgres frees session locks when it closes.
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    }
  });
}
