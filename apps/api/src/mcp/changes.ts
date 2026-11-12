// Turns a requested change ("set the rollout to 25% on") into the exact API request
// that would make it, plus a before/after preview. Pure: no I/O, so every rule here
// is unit-tested. The checks are the API's own (FlagPatchSchema + validateFlagShape),
// so a preview the user confirms can't then fail validation on apply.
import {
  FlagPatchSchema,
  validateFlagShape,
  type FlagResource,
  toFieldErrors,
} from '@ff/contracts';
import { describeRollout, type RolloutEntry, type Serve } from '@ff/eval-core';

export type ChangeRequest =
  | { type: 'set_enabled'; enabled: boolean }
  /** `weights`: percent per variant, e.g. { on: 25, off: 75 }. No ruleId = everyone else. */
  | { type: 'set_rollout'; ruleId?: string | undefined; weights: Record<string, number> }
  | { type: 'archive' };

export type Plan =
  | {
      ok: true;
      op: 'update' | 'archive';
      /** The PATCH body (undefined for an archive). */
      body?: Record<string, unknown>;
      before: string;
      after: string;
      summary: string;
    }
  | { ok: false; message: string };

const fail = (message: string): Plan => ({ ok: false, message });

/**
 * What a flag does, for previews. An off flag also says what it would serve when
 * on, so a rollout change on an off flag still shows a real before and after.
 */
export function describeFlag(flag: FlagResource): string {
  const whenOn = describeRollout({ ...flag, enabled: true }).text;
  return flag.enabled ? whenOn : `off (everyone gets ${flag.offVariant}); when on: ${whenOn}`;
}

/**
 * Same serve, compared by meaning. Not JSON.stringify: Postgres JSONB reorders object
 * keys (shorter first, so "weight" before "variant"), so a stored serve and a built
 * one with identical content would never match as strings.
 */
function sameServe(a: Serve, b: Serve): boolean {
  if ('variant' in a || 'variant' in b) {
    return 'variant' in a && 'variant' in b && a.variant === b.variant;
  }
  return (
    a.bucketBy === b.bucketBy &&
    a.rollout.length === b.rollout.length &&
    a.rollout.every(
      (e, i) => e.variant === b.rollout[i]!.variant && e.weight === b.rollout[i]!.weight,
    )
  );
}

/** 25 → 2500 basis points. Refuses finer than 0.01% rather than rounding silently. */
function toBasisPoints(percent: number): number | null {
  const bp = percent * 100;
  const rounded = Math.round(bp);
  if (!Number.isFinite(bp) || Math.abs(bp - rounded) > 1e-6 || rounded < 0) return null;
  return rounded;
}

/**
 * The new rollout, keeping the current entry order. Bucketing gives each variant a
 * contiguous range in listed order (eval-core bucket.ts), so growing "on" from 10%
 * to 25% keeps everyone who already had it. Variants new to the rollout go after,
 * in the flag's variant order; existing entries not mentioned drop to 0%. A variant
 * new to the rollout at 0% isn't added: it serves nobody, so it would only turn an
 * unchanged rollout into a "change" (review #9).
 */
function buildRollout(
  flag: FlagResource,
  current: Serve,
  weights: Record<string, number>,
): { serve: Serve } | { error: string } {
  const variantKeys = flag.variants.map((v) => v.key);
  const unknown = Object.keys(weights).filter((k) => !variantKeys.includes(k));
  if (unknown.length) {
    return {
      error: `unknown variant(s) ${unknown.join(', ')}; this flag has ${variantKeys.join(', ')}`,
    };
  }
  const bp: Record<string, number> = {};
  for (const [variant, percent] of Object.entries(weights)) {
    const value = toBasisPoints(percent);
    if (value === null) {
      return { error: `${variant}: ${percent}% isn't a valid share (0-100, at most 2 decimals)` };
    }
    bp[variant] = value;
  }
  const total = Object.values(bp).reduce((a, b) => a + b, 0);
  if (total !== 10000) return { error: `percentages must add up to 100, got ${total / 100}` };

  const isNewAndServed = (k: string) =>
    (bp[k] ?? 0) > 0 && !('rollout' in current && current.rollout.some((r) => r.variant === k));
  const order = [
    ...('rollout' in current ? current.rollout.map((r) => r.variant) : []),
    ...variantKeys.filter(isNewAndServed),
  ];
  const rollout: RolloutEntry[] = order.map((variant) => ({ variant, weight: bp[variant] ?? 0 }));
  // A rollout keeps its bucketBy; a single-variant serve had none.
  return {
    serve:
      'rollout' in current && current.bucketBy !== undefined
        ? { rollout, bucketBy: current.bucketBy }
        : { rollout },
  };
}

export function planChange(flag: FlagResource, change: ChangeRequest): Plan {
  const before = describeFlag(flag);

  if (change.type === 'archive') {
    return {
      ok: true,
      op: 'archive',
      before,
      after: 'archived: gone from the rules; SDKs serve their own defaults for it',
      // The API refuses to create a flag with an archived key (flags.ts), so say so.
      summary:
        `Archive "${flag.key}". This is permanent: it stops being served, it can't be ` +
        `restored, and the key "${flag.key}" can never be used for a new flag.`,
    };
  }

  let body: Record<string, unknown>;
  if (change.type === 'set_enabled') {
    if (flag.enabled === change.enabled) {
      return fail(`"${flag.key}" is already ${flag.enabled ? 'on' : 'off'}; nothing to change`);
    }
    body = { enabled: change.enabled };
  } else {
    const ruleIndex =
      change.ruleId === undefined ? -1 : flag.rules.findIndex((r) => r.id === change.ruleId);
    if (change.ruleId !== undefined && ruleIndex === -1) {
      const ids = flag.rules.map((r) => r.id);
      return fail(
        `no rule "${change.ruleId}" on "${flag.key}"; ` +
          (ids.length ? `its rules are ${ids.join(', ')}` : 'it has no rules') +
          ' (leave ruleId out for everyone else)',
      );
    }
    const rule = flag.rules[ruleIndex];
    const currentServe = rule ? rule.serve : flag.defaultServe;
    const built = buildRollout(flag, currentServe, change.weights);
    if ('error' in built) return fail(built.error);
    if (sameServe(built.serve, currentServe)) {
      return fail(`"${flag.key}" already serves that; nothing to change`);
    }
    // PATCH replaces whole fields, so a rule change sends every rule.
    body = rule
      ? { rules: flag.rules.map((r, i) => (i === ruleIndex ? { ...r, serve: built.serve } : r)) }
      : { defaultServe: built.serve };
  }

  // The API's own checks, on the merged flag, so apply can't fail validation.
  const parsed = FlagPatchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(
      toFieldErrors(parsed.error)
        .map((e) => `${e.path}: ${e.message}`)
        .join('; '),
    );
  }
  const merged = { ...flag, ...body } as FlagResource;
  const errors = validateFlagShape(merged);
  if (errors.length) return fail(errors.map((e) => `${e.path}: ${e.message}`).join('; '));

  const after = describeFlag(merged);
  const verb = change.type === 'set_enabled' ? (change.enabled ? 'Turn on' : 'Turn off') : 'Change';
  return {
    ok: true,
    op: 'update',
    body,
    before,
    after,
    summary: `${verb} "${flag.key}": ${before} → ${after}`,
  };
}
