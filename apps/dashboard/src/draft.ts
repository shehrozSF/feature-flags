// The flag editor's form state ("draft") and its conversion to and from the API's
// flag shape. The form shows what people type: JSON text for values, percentages
// for rollout weights, comma-separated condition values. The API stores JSON
// values, basis points (0–10000) and arrays. Pure functions, unit-tested.
import { FlagInputSchema, toFieldErrors, type FlagInput, type FlagResource } from '@ff/contracts';
import type { AttributeValue, Condition, JsonValue, Operator, Rule, Serve } from '@ff/eval-core';

export type DraftServe =
  | { mode: 'variant'; variant: string }
  /** weights: percent text per variant key ('' = not in the rollout). */
  | { mode: 'rollout'; weights: Record<string, string>; bucketBy: string };
export type DraftCondition = { attribute: string; op: Operator; values: string };
export type DraftRule = { id: string; conditions: DraftCondition[]; serve: DraftServe };
export type DraftVariant = { key: string; value: string };

export type Draft = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  variants: DraftVariant[];
  offVariant: string;
  rules: DraftRule[];
  defaultServe: DraftServe;
};

export type Problem = { path: string; message: string };

export const OPERATORS: Operator[] = ['eq', 'in', 'contains', 'gt', 'lt', 'semverGte'];
const NUMERIC: ReadonlySet<Operator> = new Set(['gt', 'lt']);

// 3330 ↔ "33.3". Dividing by 100 and rounding to two places avoids float noise
// such as 33.300000000000004.
const toPercent = (basisPoints: number) => String(Math.round(basisPoints) / 100);
const toBasisPoints = (percent: string) => Math.round(Number(percent) * 100);

export function emptyDraft(): Draft {
  return {
    key: '',
    name: '',
    description: '',
    enabled: false,
    variants: [
      { key: 'on', value: 'true' },
      { key: 'off', value: 'false' },
    ],
    offVariant: 'off',
    rules: [],
    defaultServe: { mode: 'variant', variant: 'on' },
  };
}

function serveToDraft(serve: Serve): DraftServe {
  if ('variant' in serve) return { mode: 'variant', variant: serve.variant };
  return {
    mode: 'rollout',
    weights: Object.fromEntries(serve.rollout.map((r) => [r.variant, toPercent(r.weight)])),
    bucketBy: serve.bucketBy ?? '',
  };
}

export function toDraft(flag: FlagResource): Draft {
  return {
    key: flag.key,
    name: flag.name,
    description: flag.description,
    enabled: flag.enabled,
    variants: flag.variants.map((v) => ({ key: v.key, value: JSON.stringify(v.value) })),
    offVariant: flag.offVariant,
    rules: flag.rules.map((rule) => ({
      id: rule.id,
      conditions: rule.conditions.map((c) => ({
        attribute: c.attribute,
        op: c.op,
        values: c.values.map(String).join(', '),
      })),
      serve: serveToDraft(rule.serve),
    })),
    defaultServe: serveToDraft(flag.defaultServe),
  };
}

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null; // reported by problems(); the API would reject it anyway
  }
}

const splitValues = (text: string) =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

function serveFromDraft(serve: DraftServe, variantKeys: string[]): Serve {
  if (serve.mode === 'variant') return { variant: serve.variant };
  // Variants in their declared order; empty or zero weights are left out.
  const rollout = variantKeys
    .filter((key) => (serve.weights[key] ?? '').trim() !== '' && Number(serve.weights[key]) !== 0)
    .map((key) => ({ variant: key, weight: toBasisPoints(serve.weights[key]!) }));
  return serve.bucketBy.trim() ? { rollout, bucketBy: serve.bucketBy.trim() } : { rollout };
}

function conditionFromDraft(c: DraftCondition): Condition {
  const values: AttributeValue[] = splitValues(c.values).map((v) =>
    NUMERIC.has(c.op) ? Number(v) : v,
  );
  return { attribute: c.attribute.trim(), op: c.op, values };
}

/** Every editable field (PATCH replaces them all; key and salt never change). */
/** The editable fields with the flag's own (eval-core) types; assignable to FlagPatch. */
export type FlagFields = Pick<
  FlagResource,
  'name' | 'description' | 'enabled' | 'variants' | 'offVariant' | 'rules' | 'defaultServe'
>;

export function toPatch(draft: Draft): FlagFields {
  const keys = draft.variants.map((v) => v.key);
  return {
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    variants: draft.variants.map((v) => ({ key: v.key, value: parseJson(v.value) })),
    offVariant: draft.offVariant,
    rules: draft.rules.map((rule): Rule => ({
      id: rule.id,
      conditions: rule.conditions.map(conditionFromDraft),
      serve: serveFromDraft(rule.serve, keys),
    })),
    defaultServe: serveFromDraft(draft.defaultServe, keys),
  };
}

export function toInput(draft: Draft): FlagInput {
  return { key: draft.key, ...toPatch(draft) };
}

function servePercentProblems(serve: DraftServe, path: string): Problem[] {
  if (serve.mode !== 'rollout') return [];
  const out: Problem[] = [];
  let total = 0;
  for (const [variant, text] of Object.entries(serve.weights)) {
    if (text.trim() === '') continue;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      out.push({ path: `${path}.weights.${variant}`, message: 'enter a percentage' });
    } else {
      total += toBasisPoints(text);
    }
  }
  if (out.length === 0 && total !== 10000) {
    out.push({
      path: `${path}.rollout`,
      message: `weights add up to ${toPercent(total)}%, they must add up to 100%`,
    });
  }
  return out;
}

/**
 * Everything wrong with a draft: what the form can see first (bad JSON, bad
 * numbers, weights), then everything the API's own schema would reject, so the
 * Save button never sends a flag the API is known to refuse.
 */
export function problems(draft: Draft, options: { isNew?: boolean } = {}): Problem[] {
  const found: Problem[] = [];
  draft.variants.forEach((v, i) => {
    try {
      JSON.parse(v.value);
    } catch {
      found.push({
        path: `variants.${i}.value`,
        message: 'enter a JSON value, e.g. true, "blue" or 19',
      });
    }
  });
  draft.rules.forEach((rule, i) => {
    rule.conditions.forEach((c, j) => {
      if (NUMERIC.has(c.op) && splitValues(c.values).some((v) => !Number.isFinite(Number(v)))) {
        found.push({
          path: `rules.${i}.conditions.${j}.values`,
          message: `${c.op} compares numbers`,
        });
      }
    });
    found.push(...servePercentProblems(rule.serve, `rules.${i}.serve`));
  });
  found.push(...servePercentProblems(draft.defaultServe, 'defaultServe'));

  const parsed = FlagInputSchema.safeParse(toInput(draft));
  if (!parsed.success) {
    for (const e of toFieldErrors(parsed.error)) {
      if (e.path === 'key' && !options.isNew) continue; // existing keys can't change
      found.push(e);
    }
  }
  // One message per field: the form's own (friendlier) wording wins.
  const seen = new Set<string>();
  return found.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}
