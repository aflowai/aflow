import { ConflictError, PublicError, ServiceUnavailableError } from './errors.js';

/**
 * Internal-safe database error. Status 500, generic message.
 */
class DatabaseError extends PublicError {
  readonly statusCode = 500;
  readonly errorCode = 'DatabaseError';
}

/** How far to follow `cause` before giving up on a wrapped error. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The whole message chain of a database error.
 *
 * A Drizzle query error's own message carries only the SQL and its params —
 * the Postgres detail, constraint name included, hangs off `cause`. Matching
 * on `error.message` alone therefore never fires, and the logs cannot be used
 * to check that assumption: the serializer folds the cause back in, so the
 * constraint name appears there whether or not the runtime string held it.
 */
export function databaseErrorText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages.join('\n') : String(error);
}

/**
 * Returns true if the error looks like a database/Drizzle/Postgres error.
 */
export function isDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = databaseErrorText(error);
  return (
    msg.includes('Failed query:') ||
    msg.includes('duplicate key') ||
    msg.includes('violates') ||
    msg.includes('relation') ||
    msg.includes('PostgresError') ||
    error.constructor.name === 'PostgresError'
  );
}

/**
 * Classify a raw DB error into a typed PublicError with a safe message.
 * The original error message (which may contain SQL) is NOT included.
 *
 * @param error  The caught error
 * @param context  A safe verb phrase for the error message, e.g. "save credential"
 */
export function classifyDbError(error: unknown, context: string): PublicError {
  const raw = databaseErrorText(error);

  if (raw.includes('does not exist') || raw.includes('relation')) {
    return new ServiceUnavailableError(
      'Storage is not initialized. Run database migrations and restart.',
    );
  }

  if (raw.includes('unique') || raw.includes('duplicate')) {
    return new ConflictError('Duplicate record. The resource already exists.');
  }

  return new DatabaseError(`Failed to ${context}. Please try again or contact your administrator.`);
}
