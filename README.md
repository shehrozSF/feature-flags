# Feature flags

A feature-flag service: flip a switch or change a rollout in a dashboard, and a website changes live — for everyone, for a percentage of visitors, or for visitors matching targeting rules. SDKs decide flags locally, so apps keep working when the service is down.

**Status:** Milestone 1 in progress — evaluation engine and the API on Node + Postgres are done; Cloudflare deployment, SDKs and the dashboard come next.

## Repository layout

| Path                 | What it is                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `packages/eval-core` | Flag evaluation: MurmurHash3 bucketing, targeting rules, `evaluate()` / `evaluateAll()`    |
| `packages/contracts` | zod schemas and route registry for the API; `openapi.json` is generated from them          |
| `apps/api`           | The API (Hono): sandboxes, flag CRUD with optimistic locking, SDK rules, client evaluation |
| `tools/bench-check`  | Benchmark comparison used by CI                                                            |

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

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm contracts:check && pnpm test:coverage
pnpm bench && pnpm bench:report     # evaluation benchmarks
```

The API is described by [`packages/contracts/openapi.json`](packages/contracts/openapi.json) (generated — run `pnpm --filter @ff/contracts openapi:write` after changing a schema).
