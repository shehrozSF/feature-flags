# Feature flags

A feature-flag service: flip a switch or change a rollout in a dashboard, and a website changes live — for everyone, for a percentage of visitors, or for visitors matching targeting rules. SDKs decide flags locally, so apps keep working when the service is down.

**Status:** Milestone 1 in progress. The evaluation engine and the API are done and deployed on Cloudflare Workers, with server and browser SDKs; the dashboard and demo come next.

**Live API:** https://feature-flags-api.shehrozsf.workers.dev ([health](https://feature-flags-api.shehrozsf.workers.dev/health) shows the deployed commit)

## Repository layout

| Path                  | What it is                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/eval-core`  | Flag evaluation: MurmurHash3 bucketing, targeting rules, `evaluate()` / `evaluateAll()`                       |
| `packages/contracts`  | zod schemas and route registry for the API; `openapi.json` is generated from them; the shared stream protocol |
| `packages/sdk-server` | Server SDK: streaming or polling, local evaluation, keeps the last good rules through outages                 |
| `packages/sdk-client` | Browser SDK: remote evaluation, cached per visitor, live updates, pauses in hidden tabs                       |
| `apps/api`            | The API (Hono): sandboxes, flag CRUD with optimistic locking, SDK rules, client evaluation                    |
| `tools/bench-check`   | Benchmark comparison used by CI                                                                               |
| `tools/smoke`         | Smoke test for a running API (`pnpm smoke <url>`), run by CI after every deploy                               |
| `tools/fault-proxy`   | Test helpers: a fake API and a proxy that takes the network down, delays it or corrupts it                    |

## Using the SDKs

Both SDKs never throw from `variation` and return your fallback when something is wrong (no rules yet, unknown flag, a value of another type).

**Server** (Node, or Workers in polling mode). Rules are evaluated locally:

```ts
import { createServerClient } from '@ff/sdk-server';

const flags = await createServerClient({ serverKey, baseUrl, mode: 'streaming' }); // ≤ 2 s, never rejects
flags.variation('new-pricing', { userId: 'u1', plan: 'pro' }, false);
flags.on('change', (version) => console.log('rules now at version', version));
// Workers: mode 'polling', and ctx.waitUntil(flags.pending()) so a background revalidation
// that variation() started isn't cut off when the response is sent (no extra requests).
```

**Browser.** The API evaluates for the visitor; results are cached and kept live:

```ts
import { createBrowserClient } from '@ff/sdk-client';

const flags = createBrowserClient({ clientKey, baseUrl, context: { country: 'PK' } }); // anonymous id added
await flags.ready(); // at once from cache, else after the first answer (≤ 2 s)
flags.variation('promo-banner', false);
flags.on('change', () => render());
await flags.identify({ userId: 'u42', country: 'PK', plan: 'pro' }); // after login
```

Resilience is tested by breaking the network on purpose: API down, recovery, slow start and malformed answers ([testing guide §9](docs/testing-guide.md), local).

## Local development

Requirements: Node 24, pnpm (`corepack enable`), Docker Desktop.

```bash
pnpm install

# Tests (integration tests start a throwaway Postgres in Docker)
pnpm test

# Run the API locally
docker compose up -d                                              # Postgres on localhost:5432
DATABASE_URL=postgres://ff:ff@localhost:5432/ff pnpm --filter @ff/api migrate
DATABASE_URL=postgres://ff:ff@localhost:5432/ff pnpm --filter @ff/api dev   # http://localhost:8787
```

Try it:

```bash
# Create a sandbox: returns a project id and admin / server / client keys
curl -s -X POST localhost:8787/v1/sandboxes

# Evaluate every flag for a visitor from Pakistan (use the client key from above)
curl -s -H "Authorization: Bearer <client key>" -H "content-type: application/json" \
     -d '{"context":{"userId":"u1","country":"PK"}}' localhost:8787/v1/client/evaluate
```

On Windows PowerShell, set the variable first: `$env:DATABASE_URL = "postgres://ff:ff@localhost:5432/ff"`.

The Node server keeps project hubs in memory. To run the real Worker locally, with Durable Objects and WebSockets:

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://ff:ff@localhost:5432/ff pnpm --filter @ff/api cf:dev
pnpm smoke http://localhost:8787     # all six checks, including the WebSocket one
```

## How it runs in production

- **Cloudflare Workers** runs the API (`apps/api/src/adapters/cloudflare/worker.ts`). Each project gets a **ProjectHub Durable Object** that caches its rules and key hashes and pushes change notices over WebSockets.
- **Neon Postgres** is the source of truth, reached through **Hyperdrive** (connection pooling, caching disabled).
- **Deploys are automatic.** Every push to `main` that passes the `check` and `bench` jobs runs the `deploy` job: migrate Neon → `wrangler deploy` → smoke test the live URL → confirm `/health` reports the new commit. Deploys queue instead of overlapping.
- **GitHub secrets it needs:** `DATABASE_URL` (Neon's **direct** URL: migrations hold an advisory lock, which a pooled connection can't keep), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The token only needs _Workers Scripts: Edit_, _Account Settings: Read_ and _User Details / Memberships: Read_. If a deploy fails with `Authentication error [code: 10000]`, add the one permission the error names.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm contracts:check && pnpm test:coverage
pnpm bench && pnpm bench:report     # evaluation benchmarks
```

The API is described by [`packages/contracts/openapi.json`](packages/contracts/openapi.json) (generated — run `pnpm --filter @ff/contracts openapi:write` after changing a schema).
