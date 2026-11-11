// What to tell a person when something goes wrong, and how to describe a flag in
// a few words. Plain functions, so the wording lives in one place. Every summary is
// derived from the flag itself: no invented analytics, history or environments.
import type { FlagResource } from '@ff/contracts';
import type { Condition, Operator, Rule, Serve } from '@ff/eval-core';
import { ApiError } from './api';

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  const p = error.problem;
  switch (p.kind) {
    case 'conflict':
      return 'Someone changed this flag elsewhere first; showing their version.';
    case 'invalid':
      return p.errors.length > 0
        ? `The flag isn't valid: ${p.errors.map((e) => e.message).join('; ')}.`
        : "The flag isn't valid.";
    case 'not-found':
      return 'That flag no longer exists.';
    case 'unauthorized':
      return 'This sandbox is no longer valid (it may have expired). Use "Start over" to get a new one.';
    case 'rate-limited':
      // The API's own words say what was limited and how long to wait.
      return p.detail
        ? `${p.detail.charAt(0).toUpperCase()}${p.detail.slice(1)}.`
        : 'Too many requests. Please try again later.';
    case 'unavailable':
      return 'The API is reconnecting to its database. Please try again in a few seconds.';
    case 'network':
      return "Couldn't reach the API. Check your connection and try again.";
  }
}

/** True when the sandbox's admin key no longer works (usually: it expired). */
export const isExpired = (error: unknown) =>
  error instanceof ApiError && error.problem.kind === 'unauthorized';

/**
 * The save worked, but live clients weren't told yet (`x-propagation: delayed`).
 * The hub catches up on its next stale read, so no precise time is promised.
 */
export const DELAYED_TEXT =
  'Saved, but live updates are delayed: the demo will catch up when it next refreshes its rules.';

export const percent = (basisPoints: number) => `${Number((basisPoints / 100).toFixed(2))}%`;

export const OPERATOR_TEXT: Record<Operator, string> = {
  eq: 'equals',
  in: 'is one of',
  contains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  semverGte: 'version ≥',
};

/** One served variant (or one slice of a rollout), with its share in basis points. */
export type Segment = { variant: string; weight: number; colour: number };

/**
 * What a serve hands out, as segments. `colour` is the variant's position in the
 * flag (1-based), so a variant keeps its colour everywhere it's drawn.
 */
export function segments(serve: Serve, variantKeys: string[]): Segment[] {
  const colour = (key: string) => {
    const i = variantKeys.indexOf(key);
    return i === -1 ? 0 : (i % 10) + 1;
  };
  if ('variant' in serve)
    return [{ variant: serve.variant, weight: 10000, colour: colour(serve.variant) }];
  return serve.rollout.map((r) => ({
    variant: r.variant,
    weight: r.weight,
    colour: colour(r.variant),
  }));
}

/** "Serves on", or "blue 50% · green 50%". */
export function describeServe(serve: Serve): string {
  return 'variant' in serve
    ? `Serves ${serve.variant}`
    : serve.rollout.map((r) => `${r.variant} ${percent(r.weight)}`).join(' · ');
}

/** For sentences: "serve on", or "serve on to 10% and off to 90%". */
export function serveSentence(serve: Serve): string {
  if ('variant' in serve) return `serve ${serve.variant}`;
  if (serve.rollout.length === 0) return 'serve nothing yet (no weights set)';
  const parts = serve.rollout.map((r) => `${r.variant} to ${percent(r.weight)}`);
  const last = parts.pop()!;
  return `serve ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}

export function describeCondition(c: Condition): string {
  const values = c.values.map(String).join(', ');
  return `${c.attribute || '…'} ${OPERATOR_TEXT[c.op]} ${values || '…'}`;
}

/** e.g. "country is one of PK → on". */
export function describeRule(rule: Rule): string {
  const when = rule.conditions.map(describeCondition).join(' and ');
  const then = 'variant' in rule.serve ? rule.serve.variant : describeServe(rule.serve);
  return `${when} → ${then}`;
}

export const ruleCount = (n: number) => `${n} ${n === 1 ? 'rule' : 'rules'}`;

/** e.g. "Serves on", "blue 50% · green 50%", "Off: serves off", plus the rule count. */
export function describeServing(flag: FlagResource): string {
  if (!flag.enabled) return `Off: serves ${flag.offVariant}`;
  const base = describeServe(flag.defaultServe);
  const rules = flag.rules.length;
  return rules === 0 ? base : `${ruleCount(rules)}, then ${base}`;
}
