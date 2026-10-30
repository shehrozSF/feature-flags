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

export class PreconditionRequiredError extends DomainError {
  constructor() {
    super(428, 'send If-Match with the version you last read, to avoid overwriting someone else');
  }
}
