// Deletes expired sandboxes (spec §9.2, ADR 0024). Run hourly by a Cron Trigger,
// a batch at a time: each deleted project costs one call to its hub, and a cron
// run may only make so many calls (free plan: 1,000 to Cloudflare services).
import type { HubClient } from '../hub/hub-client';
import { log } from '../log';
import type { Repository } from './ports';

/** Per cron run; hourly, that's up to 2,400 a day, far more than the demo needs. */
export const PURGE_BATCH = 100;

export async function purgeExpired(deps: {
  repo: Repository;
  hub: (projectId: string) => HubClient;
  batch?: number;
}): Promise<{ deleted: number }> {
  // Delete first (committed when this returns), then clear the hubs: cleared
  // first, a reload in between could refill a hub for a project still in Postgres.
  const ids = await deps.repo.deleteExpired(deps.batch ?? PURGE_BATCH);
  const results = await Promise.allSettled(ids.map((id) => deps.hub(id).clear()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      // The project is gone either way. Its hub serves the old rules until its
      // staleness refresh finds no project and clears itself.
      log('error', 'hub clear failed', { projectId: ids[i]!, error: result.reason });
    }
  });
  return { deleted: ids.length };
}
