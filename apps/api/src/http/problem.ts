// Every error response is RFC 9457 problem+json, so clients handle all errors
// the same way: { type, title, status, detail?, errors? }.
import type { FieldError } from '@ff/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  ConflictError,
  DomainError,
  ServiceUnavailableError,
  ValidationError,
} from '../domain/errors';
import { toResource } from '../domain/flags';
import { log } from '../log';
import { isConnectionError } from '../repo/pg-errors';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function problem(
  c: Context,
  status: number,
  detail?: string,
  extra: { errors?: FieldError[]; current?: unknown } = {},
  headers: Record<string, string> = {},
): Response {
  const body = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
  return c.body(JSON.stringify(body), status as 400, {
    ...headers,
    'content-type': 'application/problem+json',
  });
}

const RETRY_AFTER_SECONDS = 5;

/** Thrown when the request body isn't valid JSON. */
export class BadJsonError extends Error {}

export function errorToProblem(error: Error, c: Context): Response {
  if (error instanceof ValidationError) {
    return problem(c, 422, error.message, { errors: error.errors });
  }
  if (error instanceof ConflictError) {
    return problem(
      c,
      409,
      error.message,
      error.current ? { current: toResource(error.current) } : {},
    );
  }
  if (error instanceof ServiceUnavailableError) {
    // Short outages (Postgres restart, failover) usually pass within seconds.
    return problem(c, 503, error.message, {}, { 'retry-after': String(RETRY_AFTER_SECONDS) });
  }
  if (isConnectionError(error)) {
    // Admin routes always need Postgres; logged, since an outage is worth seeing.
    log('warn', 'database unreachable', { error });
    const unavailable = new ServiceUnavailableError();
    return problem(c, 503, unavailable.message, {}, { 'retry-after': String(RETRY_AFTER_SECONDS) });
  }
  if (error instanceof DomainError) return problem(c, error.status, error.message);
  if (error instanceof BadJsonError) return problem(c, 400, 'the request body is not valid JSON');
  if (error instanceof HTTPException) return problem(c, error.status, error.message || undefined);
  // Unexpected: don't leak internals to the client (or, via the message, to the logs).
  log('error', 'unexpected error', { error });
  return problem(c, 500, 'something went wrong');
}
