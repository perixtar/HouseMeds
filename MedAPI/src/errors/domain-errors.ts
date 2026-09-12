// Mapped to HTTP responses by app.ts's setErrorHandler.
export abstract class DomainError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class UnauthorizedError extends DomainError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends DomainError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class NotFoundError extends DomainError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class ConflictError extends DomainError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

// Never an estimate, never a stale reused value.
export class PricingUnavailableError extends DomainError {
  readonly statusCode = 503;
  readonly code = 'PRICING_UNAVAILABLE';
}

export class AuthProviderError extends DomainError {
  readonly statusCode = 502;
  readonly code = 'AUTH_PROVIDER_ERROR';
}
