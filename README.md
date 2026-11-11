# Feature Flags

A feature-flag service: flip a switch or change a rollout in a dashboard, and a website changes live — for everyone, for a percentage of visitors, or for visitors matching targeting rules. SDKs decide flags locally, so apps keep working when the service is down.

**Status:** Milestone 1 in progress. The evaluation engine, the API (on Cloudflare Workers), the server and browser SDKs, the dashboard and the demo shop are done and deployed.

**Live:**

- **Dashboard:** https://shehrozsf.github.io/feature-flags/dashboard/
- **Demo shop:** https://shehrozsf.github.io/feature-flags/demo/ (open it from the dashboard, which hands it your sandbox's keys)
- **API:** https://feature-flags-api.shehrozsf.workers.dev ([health](https://feature-flags-api.shehrozsf.workers.dev/health) shows the deployed commit)

## The 30-second demo

1. Open the **[dashboard](https://shehrozsf.github.io/feature-flags/dashboard/)** and click **Create my sandbox**. You get your own project with four seeded flags; nobody else sees them.
2. Click **Open the demo site ↗**. Put the two tabs side by side.
3. **Flip `promo-banner` off** in the dashboard. The shop's sale banner disappears within about a second, without a reload: the API pushes a `changed` message over a WebSocket and the browser SDK re-evaluates.
4. In the shop, **act as a visitor from Pakistan** (Country: Pakistan → _Act as this user_). JazzCash and Easypaisa appear: `pk-local-payments` has a targeting rule `country = PK`.
5. **Edit `new-pricing`** in the dashboard: set its rollout to **on 100% · off 0%** and save. Within a couple of seconds the price drops from $24 to $19. (It starts at 10% of visitors, and Pro visitors always get it through a rule: act as a Pro user to see that.) The price comes from a separate backend Worker that evaluates the flag with the **server** SDK, against the same sandbox.
6. Optional: open the same flag in two dashboard tabs, save both. The second save gets a **conflict** panel showing both versions instead of silently overwriting.

## Repository layout

| Path                  | What it is                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/eval-core`  | Flag evaluation: MurmurHash3 bucketing, targeting rules, `evaluate()` / `evaluateAll()`                       |
| `packages/contracts`  | zod schemas and route registry for the API; `openapi.json` is generated from them; the shared stream protocol |
| `packages/sdk-server` | Server SDK: streaming or polling, local evaluation, keeps the last good rules through outages                 |
| `packages/sdk-client` | Browser SDK: remote evaluation, cached per visitor, live updates, pauses in hidden tabs                       |
| `apps/api`            | The API (Hono): sandboxes, flag CRUD with optimistic locking, SDK rules, client evaluation                    |
| `apps/dashboard`      | React dashboard: create a sandbox, flip flags, edit rules and rollouts, resolve edit conflicts                |
| `apps/demo-site`      | Demo shop: each part follows one flag through the browser SDK, live                                           |
| `apps/demo-backend`   | The demo shop's pricing endpoint: a Worker evaluating `new-pricing` with the server SDK                       |
| `tools/bench-check`   | Benchmark comparison used by CI                                                                               |
| `tools/smoke`         | Smoke test for a running API and pricing backend (`pnpm smoke <url>`), run by CI after every deploy           |
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

Run the dashboard and demo shop against it (each in its own terminal):

```bash
pnpm --filter @ff/dashboard dev      # http://localhost:5173/feature-flags/dashboard/
pnpm --filter @ff/demo-site dev      # http://localhost:5174/feature-flags/demo/
pnpm --filter @ff/demo-backend dev   # pricing backend on http://localhost:8790, reading the local API
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
- **GitHub Pages** serves the dashboard and the demo shop as one site: `/feature-flags/dashboard/` and `/feature-flags/demo/`. A second Worker, **demo-backend**, prices the demo shop's product with the server SDK.
- **Deploys are automatic.** Every push to `main` that passes the `check` and `bench` jobs runs the `deploy` job: migrate Neon → deploy the API → deploy demo-backend → smoke test both (including CORS from the Pages origin) → confirm `/health` reports the new commit. The `pages` job then builds and publishes both apps. Deploys queue instead of overlapping.
- **GitHub secrets it needs:** `DATABASE_URL` (Neon's **direct** URL: migrations hold an advisory lock, which a pooled connection can't keep), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The token only needs _Workers Scripts: Edit_, _Account Settings: Read_ and _User Details / Memberships: Read_. If a deploy fails with `Authentication error [code: 10000]`, add the one permission the error names.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm contracts:check && pnpm test:coverage
pnpm bench && pnpm bench:report     # evaluation benchmarks
```

The API is described by [`packages/contracts/openapi.json`](packages/contracts/openapi.json) (generated — run `pnpm --filter @ff/contracts openapi:write` after changing a schema).
