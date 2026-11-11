// Errors the domain raises on purpose. Each carries the HTTP status it maps to,
// so the HTTP layer can turn it into a problem+json response without a lookup.
import type { FieldError } from '@ff/contracts';
import type { StoredFlag } from './ports';

export class DomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(detail = 'not found') {
    super(404, detail);
  }
}

export class ConflictError extends DomainError {
  constructor(
    detail: string,
    readonly current?: StoredFlag,
  ) {
    super(409, detail);
  }
}

export class ValidationError extends DomainError {
  constructor(readonly errors: FieldError[]) {
    super(422, 'the request body is invalid');
  }
}

/** Over a rate limit (spec §9.2): `what` names it for the message, e.g. "evaluate requests". */
export class RateLimitedError extends DomainError {
  constructor(
    readonly retryAfterMs: number,
    readonly what: string,
  ) {
    super(429, `too many ${what}`);
  }
}

/** A dependency (Postgres) is down and there is nothing cached to serve instead. */
export class ServiceUnavailableError extends DomainError {
  constructor(detail = 'the service is temporarily unavailable; try again shortly') {
    super(503, detail);
  }
}

export class PreconditionRequiredError extends DomainError {
  constructor() {
    super(428, 'send If-Match with the version you last read, to avoid overwriting someone else');
  }
}
