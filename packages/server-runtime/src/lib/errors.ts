/**
 * Base class for errors whose messages are safe to send to API clients.
 * Any Error that is NOT a PublicError will have its message replaced
 * with a generic string by the global error handler.
 */
export abstract class PublicError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errorCode: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BadRequestError extends PublicError {
  readonly statusCode = 400;
  readonly errorCode: string;

  constructor(message: string, errorCode = 'BadRequest') {
    super(message);
    this.errorCode = errorCode;
  }
}

export class ForbiddenError extends PublicError {
  readonly statusCode = 403;
  readonly errorCode = 'Forbidden';
}

export class NotFoundError extends PublicError {
  readonly statusCode = 404;
  readonly errorCode = 'NotFound';
}

export class ConflictError extends PublicError {
  readonly statusCode = 409;
  readonly errorCode = 'Conflict';
}

export class TooManyRequestsError extends PublicError {
  readonly statusCode = 429;
  readonly errorCode = 'TooManyRequests';
}

export class ServiceUnavailableError extends PublicError {
  readonly statusCode = 503;
  readonly errorCode = 'ServiceUnavailable';
}

/**
 * Classify a raw Error thrown by runService into a typed PublicError.
 *
 * The runService throws plain Errors with well-known message patterns
 * (e.g., "Run X not found", "Run X is not paused", "Resume mismatch").
 * This function maps those patterns to appropriate HTTP status codes
 * while keeping the message (it's our own controlled text, not DB output).
 */
export function classifyRunServiceError(err: unknown): PublicError {
  const msg = err instanceof Error ? err.message : 'Unknown error';

  // Admission control 429
  if (
    err instanceof Error &&
    'statusCode' in err &&
    (err as Error & { statusCode: number }).statusCode === 429
  ) {
    return new TooManyRequestsError(msg);
  }

  // Respect explicit statusCode set by service layer
  if (err instanceof Error && 'statusCode' in err) {
    const code = (err as Error & { statusCode: number }).statusCode;
    if (code === 403) return new ForbiddenError(msg);
    if (code === 404) return new NotFoundError(msg);
    if (code === 409) return new ConflictError(msg);
  }

  if (msg.includes('not found')) {
    return new NotFoundError(msg);
  }
  if (msg.includes('not paused') || msg.includes('not failed') || msg.includes('mismatch')) {
    return new ConflictError(msg);
  }

  // Default: treat as bad request (preserves existing behavior)
  return new BadRequestError(msg);
}
