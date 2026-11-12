// Bindings come from wrangler.jsonc via the generated worker-configuration.d.ts
// (`pnpm cf:types`). GIT_SHA is set by the deploy job, so treat it as optional.
// MCP_CONFIRM_SECRET is a Worker secret (`wrangler secret put`), so it isn't in
// wrangler.jsonc; without it, MCP is read-only (ADR 0038).
export type Env = Omit<Cloudflare.Env, 'GIT_SHA'> & {
  GIT_SHA?: string;
  MCP_CONFIRM_SECRET?: string;
};
