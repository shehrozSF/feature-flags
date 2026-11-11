// localStorage helpers for the browser SDK (spec §8.2). Every access is wrapped:
// storage can throw on any call (private mode, full quota, blocked by the user),
// and the SDK must keep working without it.
import { EvaluateResponseSchema } from '@ff/contracts';
import type { Context, Result } from '@ff/eval-core';

export type Results = { version: number; flags: Record<string, Result> };

const ANON_ID_KEY = 'ff:anon-id';

/** globalThis.localStorage, or null where reading it throws or it doesn't exist. */
export function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function remove(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing more we can do.
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // No cache this time; the SDK works without one.
  }
}

/** JSON with object keys sorted, so {a, b} and {b, a} give the same text. */
function stableJson(context: Context): string {
  const sorted = Object.keys(context)
    .filter((k) => context[k] !== undefined)
    .sort()
    .map((k) => [k, context[k]]);
  return JSON.stringify(sorted);
}

/** FNV-1a, 32-bit, as 8 hex characters: short, stable, good enough to tell contexts apart. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** ff:v1:<clientKey>:<hash of the context> (plan decision 6). */
export function cacheKey(clientKey: string, context: Context): string {
  return `ff:v1:${clientKey}:${fnv1a32(stableJson(context))}`;
}

/** The visitor's random id, created once and remembered (spec §8.2). */
export function anonymousId(storage: Storage | null): string {
  const existing = read(storage, ANON_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  write(storage, ANON_ID_KEY, id);
  return id;
}

/** Cached results for a key, or null if absent or not valid (never trusted blindly). */
export function readCache(storage: Storage | null, key: string): Results | null {
  const raw = read(storage, key);
  if (!raw) return null;
  try {
    const parsed = EvaluateResponseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** How many visitors' results are kept per client key; older ones are deleted. */
export const MAX_CACHED_CONTEXTS = 5;

/**
 * Stores a visitor's results and keeps only the MAX_CACHED_CONTEXTS most recently
 * written per client key (an index entry lists them, newest first). Without a
 * limit, an app with a changing context would fill the origin's storage quota and
 * break its own localStorage writes (final review I5).
 */
export function writeCache(
  storage: Storage | null,
  clientKey: string,
  context: Context,
  results: Results,
): void {
  const key = cacheKey(clientKey, context);
  const indexKey = `ff:v1:${clientKey}:index`;
  let index: string[] = [];
  try {
    const parsed: unknown = JSON.parse(read(storage, indexKey) ?? '[]');
    if (Array.isArray(parsed)) index = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    // A broken index is rebuilt from scratch.
  }
  index = [key, ...index.filter((k) => k !== key)];
  for (const evicted of index.slice(MAX_CACHED_CONTEXTS)) remove(storage, evicted);
  write(storage, indexKey, JSON.stringify(index.slice(0, MAX_CACHED_CONTEXTS)));
  write(storage, key, JSON.stringify(results));
}
