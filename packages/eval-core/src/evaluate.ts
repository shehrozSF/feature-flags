import { bucketFor, pickRolloutVariant } from './bucket';
import { matchCondition } from './operators';
import type { Context, Flag, JsonValue, Result, Ruleset, Serve, Variant } from './types';

/** The variant with this key, or null if it's missing or has no value. */
function findVariant(flag: Flag, key: string | null): Variant | null {
  const v = flag.variants.find((variant) => variant.key === key);
  return v && Object.hasOwn(v, 'value') ? v : null;
}

function resolveServe(flag: Flag, serve: Serve, context: Context): Variant | null {
  let key: string | null;
  if ('variant' in serve) {
    key = serve.variant;
  } else {
    const attribute = serve.bucketBy ?? 'userId';
    const value = Object.hasOwn(context, attribute) ? context[attribute] : undefined;
    key = pickRolloutVariant(serve.rollout, bucketFor(flag.salt, value));
  }
  return findVariant(flag, key);
}

/**
 * Decide a flag for a context (spec §5.2): off → first matching rule → default.
 * Never throws: anything unexpected returns the fallback with reason ERROR.
 */
export function evaluate(
  ruleset: Ruleset,
  flagKey: string,
  context: Context,
  fallback: JsonValue,
): Result {
  const error: Result = { variant: null, value: fallback, reason: 'ERROR' };
  try {
    if (!Object.hasOwn(ruleset.flags, flagKey)) {
      return { variant: null, value: fallback, reason: 'FLAG_NOT_FOUND' };
    }
    const flag = ruleset.flags[flagKey]!;

    if (!flag.enabled) {
      const off = findVariant(flag, flag.offVariant);
      return off ? { variant: off.key, value: off.value, reason: 'OFF' } : error;
    }

    for (const rule of flag.rules) {
      if (rule.conditions.every((c) => matchCondition(c, context))) {
        const v = resolveServe(flag, rule.serve, context);
        return v
          ? { variant: v.key, value: v.value, reason: 'RULE_MATCH', ruleId: rule.id }
          : error;
      }
    }

    const v = resolveServe(flag, flag.defaultServe, context);
    return v ? { variant: v.key, value: v.value, reason: 'DEFAULT' } : error;
  } catch {
    return error;
  }
}

/** Every flag in the ruleset for one context, with a null fallback (client evaluation). */
export function evaluateAll(ruleset: Ruleset, context: Context): Record<string, Result> {
  const results: Record<string, Result> = {};
  try {
    for (const key of Object.keys(ruleset.flags)) {
      results[key] = evaluate(ruleset, key, context, null);
    }
  } catch {
    return {};
  }
  return results;
}
