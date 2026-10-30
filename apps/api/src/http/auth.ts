// Bearer-key authentication (spec §6.2). Malformed or unknown keys → 401.
// A well-formed key of the wrong kind → 403, decided from the key text alone,
// before any database or hub lookup.
import { createMiddleware } from 'hono/factory';
import type { KeyVerifier } from '../domain/ports';
import { parseKey, type KeyKind } from '../keys';
import { problem } from './problem';

export type AuthEnv = { Variables: { projectId: string } };

export function requireKey(kind: KeyKind, keys: KeyVerifier) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const key = parseKey(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null);
    if (!key) return problem(c, 401, 'send a valid key as "Authorization: Bearer <key>"');
    if (key.kind !== kind) return problem(c, 403, `this route needs a ${kind} key`);
    if (!(await keys.verify(key))) return problem(c, 401, 'unknown or revoked key');
    c.set('projectId', key.projectId);
    await next();
  });
}
