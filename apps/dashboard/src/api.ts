// The dashboard's client for the admin API (spec §6.1). Every answer is checked
// against the contract schemas, and every failure becomes an ApiError with a kind
// the UI can explain, so a broken or unexpected answer is a message, not a crash.
import {
  ConflictProblemSchema,
  FlagListSchema,
  FlagSchema,
  ProblemSchema,
  SandboxResponseSchema,
  type FieldError,
  type FlagInput,
  type FlagPatch,
  type FlagResource,
} from '@ff/contracts';
import type { z } from 'zod';

export type Keys = { admin: string; server: string; client: string };
export type Sandbox = { projectId: string; keys: Keys };

export type ApiProblem =
  /** 409: someone else saved this flag first; `current` is what they saved. */
  | { kind: 'conflict'; current: FlagResource }
  /** 422 (or 400): the flag isn't valid; errors point at fields. */
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'not-found' }
  /** 401/403: the sandbox key is wrong or the sandbox expired. */
  | { kind: 'unauthorized' }
  /** 503: the API is up but its database isn't; try again after retryAfterMs. */
  | { kind: 'unavailable'; retryAfterMs: number }
  /** No answer, or an answer that doesn't match the contract. */
  | { kind: 'network'; message: string };

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(`API error: ${problem.kind}`);
    this.name = 'ApiError';
  }
}

/** A write's result, plus whether live clients have it yet (`x-propagation`, spec §9.1). */
export type Saved<T> = { value: T; propagation: 'ok' | 'delayed' };

const DEFAULT_RETRY_AFTER_MS = 5000;

async function send(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (error) {
    throw new ApiError({
      kind: 'network',
      message: error instanceof Error ? error.message : 'request failed',
    });
  }
  if (res.ok) return res;

  const body: unknown = await res.json().catch(() => null);
  switch (res.status) {
    case 409: {
      const parsed = ConflictProblemSchema.safeParse(body);
      if (parsed.success) throw new ApiError({ kind: 'conflict', current: parsed.data.current });
      // A 409 with no current flag: a create whose key is taken (or archived).
      const plain = ProblemSchema.safeParse(body);
      throw new ApiError({
        kind: 'invalid',
        errors: [
          {
            path: 'key',
            message: (plain.success && plain.data.detail) || 'a flag with this key already exists',
          },
        ],
      });
    }
    case 400:
    case 422: {
      const parsed = ProblemSchema.safeParse(body);
      throw new ApiError({
        kind: 'invalid',
        errors: parsed.success ? (parsed.data.errors ?? []) : [],
      });
    }
    case 401:
    case 403:
      throw new ApiError({ kind: 'unauthorized' });
    case 404:
      throw new ApiError({ kind: 'not-found' });
    case 503: {
      const seconds = Number(res.headers.get('retry-after'));
      const retryAfterMs =
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
      throw new ApiError({ kind: 'unavailable', retryAfterMs });
    }
  }
  throw new ApiError({ kind: 'network', message: `unexpected answer ${res.status}` });
}

async function parse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiError({ kind: 'network', message: "the API's answer didn't match the contract" });
  }
  return parsed.data;
}

const propagation = (res: Response): Saved<unknown>['propagation'] =>
  res.headers.get('x-propagation') === 'delayed' ? 'delayed' : 'ok';

export function createAdminApi(options: {
  baseUrl: string;
  adminKey: string;
  fetch?: typeof fetch;
}) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const auth = { authorization: `Bearer ${options.adminKey}` };
  const flagUrl = (key: string) => `${base}/v1/flags/${encodeURIComponent(key)}`;
  const jsonBody = (body: unknown) => ({
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    async listFlags(): Promise<FlagResource[]> {
      const res = await send(fetchFn, `${base}/v1/flags`, { headers: auth });
      return (await parse(res, FlagListSchema)).flags;
    },

    async getFlag(key: string): Promise<FlagResource> {
      return parse(await send(fetchFn, flagUrl(key), { headers: auth }), FlagSchema);
    },

    async createFlag(input: FlagInput): Promise<Saved<FlagResource>> {
      const res = await send(fetchFn, `${base}/v1/flags`, { method: 'POST', ...jsonBody(input) });
      return { value: await parse(res, FlagSchema), propagation: propagation(res) };
    },

    async updateFlag(key: string, version: number, patch: FlagPatch): Promise<Saved<FlagResource>> {
      const body = jsonBody(patch);
      const res = await send(fetchFn, flagUrl(key), {
        method: 'PATCH',
        ...body,
        headers: { ...body.headers, 'if-match': `"${version}"` },
      });
      return { value: await parse(res, FlagSchema), propagation: propagation(res) };
    },

    async archiveFlag(key: string, version: number): Promise<Saved<null>> {
      const res = await send(fetchFn, flagUrl(key), {
        method: 'DELETE',
        headers: { ...auth, 'if-match': `"${version}"` },
      });
      return { value: null, propagation: propagation(res) };
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

export async function createSandbox(baseUrl: string, fetchFn?: typeof fetch): Promise<Sandbox> {
  const res = await send(
    fetchFn ?? globalThis.fetch.bind(globalThis),
    `${baseUrl.replace(/\/+$/, '')}/v1/sandboxes`,
    { method: 'POST' },
  );
  return parse(res, SandboxResponseSchema);
}
