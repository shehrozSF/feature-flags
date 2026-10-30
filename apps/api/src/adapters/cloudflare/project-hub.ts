import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

// One hub per project: holds its snapshot and its WebSocket clients.
// Empty for now so the binding and migration in wrangler.jsonc are valid.
export class ProjectHub extends DurableObject<Env> {}
