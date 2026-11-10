// Bindings come from wrangler.jsonc via the generated worker-configuration.d.ts
// (`pnpm cf:types`). GIT_SHA is set by the deploy job, so treat it as optional.
export type Env = Omit<Cloudflare.Env, 'GIT_SHA'> & { GIT_SHA?: string };
