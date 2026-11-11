// GET /v1/sdk/rules (spec §6.1), conditional on the ETag held. Never throws: every
// problem becomes `failed`, and only a ruleset that passes the contract schema is
// ever returned (spec §8.1 failure policy).
import { RulesetSchema } from '@ff/contracts';
import type { Ruleset } from '@ff/eval-core';

export type Logger = { warn(message: string): void };

export type FetchResult =
  | { kind: 'updated'; ruleset: Ruleset; etag: string | null }
  | { kind: 'unchanged'; etag: string | null }
  | { kind: 'failed'; retryAfterMs?: number };

const describe = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');

/** Retry-After in seconds (spec §9.1: 503 and 429 send it). */
function retryAfter(res: Response): { retryAfterMs?: number } {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {};
}

export async function fetchRules(options: {
  fetch: typeof fetch;
  baseUrl: string;
  serverKey: string;
  /** Sent back exactly as received: behind Cloudflare it is weak, W/"N" (issues #47). */
  etag: string | null;
  signal: AbortSignal;
  logger: Logger;
}): Promise<FetchResult> {
  let res: Response;
  try {
    res = await options.fetch(`${options.baseUrl}/v1/sdk/rules`, {
      headers: {
        authorization: `Bearer ${options.serverKey}`,
        ...(options.etag ? { 'if-none-match': options.etag } : {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (!options.signal.aborted) {
      options.logger.warn(`feature flags: could not reach the API: ${describe(error)}`);
    }
    return { kind: 'failed' };
  }

  if (res.status === 304)
    return { kind: 'unchanged', etag: res.headers.get('etag') ?? options.etag };
  if (res.status !== 200) {
    options.logger.warn(`feature flags: GET /v1/sdk/rules answered ${res.status}`);
    return { kind: 'failed', ...retryAfter(res) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    options.logger.warn(
      'feature flags: invalid JSON from /v1/sdk/rules; keeping the last good rules',
    );
    return { kind: 'failed' };
  }
  const parsed = RulesetSchema.safeParse(body);
  if (!parsed.success) {
    options.logger.warn(
      'feature flags: invalid ruleset from /v1/sdk/rules; keeping the last good rules',
    );
    return { kind: 'failed' };
  }
  return { kind: 'updated', ruleset: parsed.data, etag: res.headers.get('etag') };
}
