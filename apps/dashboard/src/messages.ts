// What to tell a person when something goes wrong, and how to describe a flag in
// one line. Plain functions, so the wording lives in one place.
import type { FlagResource } from '@ff/contracts';
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

const percent = (basisPoints: number) => `${Number((basisPoints / 100).toFixed(1))}%`;

/** e.g. "Serves on", "blue 50% · green 50%", "Off: serves off", plus the rule count. */
export function describeServing(flag: FlagResource): string {
  if (!flag.enabled) return `Off: serves ${flag.offVariant}`;
  const serve = flag.defaultServe;
  const base =
    'variant' in serve
      ? `Serves ${serve.variant}`
      : serve.rollout.map((r) => `${r.variant} ${percent(r.weight)}`).join(' · ');
  const rules = flag.rules.length;
  return rules === 0 ? base : `${rules} ${rules === 1 ? 'rule' : 'rules'}, then ${base}`;
}
