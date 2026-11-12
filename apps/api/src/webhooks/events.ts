// Flag-change events for webhooks (ADR 0039, schema FlagEventSchema in contracts).
// Pure: the dispatcher signs and sends them.
import type { FlagEvent, FlagResource } from '@ff/contracts';
import { describeFlag } from '@ff/eval-core';
import { webCrypto } from '../web';

export type Source = FlagEvent['source'];
export type Change = FlagEvent['changes'][number];

export type EventInput =
  | { type: 'flag.created'; projectId: string; after: FlagResource; source: Source }
  | {
      type: 'flag.updated' | 'flag.archived';
      projectId: string;
      before: FlagResource;
      /** For an archive: the flag as archived (its version moved on). */
      after: FlagResource;
      source: Source;
    }
  | { type: 'ping'; projectId: string };

/** Change with every write (version, updatedAt) or never matter to a reader (salt). */
const IGNORED = new Set(['version', 'updatedAt', 'salt']);

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * === except that NaN equals NaN (issues #95: a property test found a flag "changed"
 * against itself). 0 and -0 stay equal, as they are once sent as JSON.
 */
const samePrimitive = (a: Json, b: Json) => a === b || (Number.isNaN(a) && Number.isNaN(b));

function walk(a: Json, b: Json, path: string, out: Change[], top: boolean): void {
  if (isObject(a) && isObject(b)) {
    // By key name, never by position: Postgres JSONB reorders keys (issues #91).
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      if (top && IGNORED.has(k)) continue;
      walk(a[k], b[k], path ? `${path}.${k}` : k, out, false);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      walk(a[i], b[i], `${path}[${i}]`, out, false);
  } else if (!samePrimitive(a, b)) {
    // Different primitives, or different shapes (object vs array vs value): the
    // whole value on each side. A side that didn't exist is left out.
    out.push({
      path,
      ...(a !== undefined ? { from: a as Change['from'] } : {}),
      ...(b !== undefined ? { to: b as Change['to'] } : {}),
    });
  }
}

/** What changed between two versions of a flag, path by path (keys sorted). */
export function diffFlags(before: object, after: object): Change[] {
  const out: Change[] = [];
  walk(before, after, '', out, true);
  return out;
}

function summaryOf(input: EventInput, changes: Change[]): string {
  switch (input.type) {
    case 'ping':
      return 'Test event from the feature flag API: this webhook works';
    case 'flag.created':
      return `"${input.after.key}" created: ${describeFlag(input.after)}`;
    case 'flag.archived':
      return `"${input.before.key}" archived`;
    case 'flag.updated': {
      const before = describeFlag(input.before);
      const after = describeFlag(input.after);
      if (before !== after) return `"${input.after.key}": ${before} → ${after}`;
      // Serves the same (a rename, a new description, ...): name the fields instead.
      const fields = [...new Set(changes.map((c) => c.path.split(/[.[]/)[0]!))];
      // A PATCH may set fields to what they already were: saved (new version), no change.
      if (fields.length === 0) return `"${input.after.key}" saved with no changes`;
      return `"${input.after.key}" updated: ${fields.join(', ')}`;
    }
  }
}

export function buildFlagEvent(
  input: EventInput,
  { now = Date.now(), id = webCrypto.randomUUID() }: { now?: number; id?: string } = {},
): FlagEvent {
  const changes =
    input.type === 'flag.updated' ? diffFlags(input.before, input.after) : ([] as Change[]);
  const flag = input.type === 'ping' ? null : input.after;
  return {
    id,
    type: input.type,
    projectId: input.projectId,
    key: flag?.key ?? null,
    version: flag?.version ?? null,
    occurredAt: new Date(now).toISOString(),
    source: input.type === 'ping' ? 'api' : input.source,
    summary: summaryOf(input, changes),
    before: input.type === 'flag.updated' || input.type === 'flag.archived' ? input.before : null,
    // An archived flag is gone: there is no "after" to show, only its new version.
    after: input.type === 'flag.created' || input.type === 'flag.updated' ? input.after : null,
    changes,
  };
}
