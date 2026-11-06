import type pg from 'pg';

/**
 * Checks out a client for `fn` and gives it back safely when the connection dies
 * mid-use (Postgres restart, failover, idle-in-transaction timeout):
 * - while we hold it, nobody else listens for its 'error' event, and an unhandled
 *   'error' crashes the process, so we listen;
 * - a broken client is released with `true`, so the pool destroys it instead of
 *   handing it to the next query;
 * - `rollback` never throws: if it fails, the caller's original error is the one
 *   worth reporting.
 */
export async function holdClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient, rollback: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  const rollback = async () => {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
  };
  try {
    return await fn(client, rollback);
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}
