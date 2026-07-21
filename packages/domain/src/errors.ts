/**
 * Domain errors. These are transport-agnostic; adapters (e.g. the HTTP API) map
 * them onto status codes. Each carries a stable `code` for clients.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** A referenced resource does not exist within the scope. */
export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} "${id}" was not found`);
  }
}

/** A uniqueness or identity rule was violated (e.g. duplicate apiId). */
export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
  }
}

/** A field value (or set of values) failed content-model validation. */
export class ValidationError extends DomainError {
  readonly issues: readonly FieldIssue[];
  constructor(issues: readonly FieldIssue[]) {
    super('validation_failed', 'One or more fields are invalid', issues);
    this.issues = issues;
  }
}

/** An operation was attempted that the entry's current status forbids. */
export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super('invalid_state', message);
  }
}

/** A per-tenant rate/budget ceiling was exceeded (maps to HTTP 429). */
export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super('rate_limited', message, { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface FieldIssue {
  /** Field apiId the issue applies to ("" for entry-level issues). */
  readonly field: string;
  /** Locale the issue applies to, if locale-specific. */
  readonly locale?: string;
  readonly message: string;
}
