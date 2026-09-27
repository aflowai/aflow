/**
 * Drizzle wraps a Postgres failure in an error whose own message is only the
 * SQL and its params; the constraint name lives on the cause. Guards that
 * matched `error.message` therefore never fired — a duplicate that should
 * have been swallowed reached the client as a 500 instead.
 */
import { describe, it, expect } from 'vitest';
import { classifyDbError, databaseErrorText, isDatabaseError } from './databaseErrors.js';

/** The exact shape drizzle-orm throws: SQL in the message, detail on the cause. */
function drizzleQueryError(constraint: string): Error {
  const cause = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  cause.name = 'PostgresError';
  return new Error(
    'Failed query: insert into "space_grants" ("id", "tenant_id") values (default, $1)\nparams: t1',
    { cause },
  );
}

describe('databaseErrorText', () => {
  it('reaches the constraint name the top-level message omits', () => {
    const err = drizzleQueryError('space_grants_pending_unique');
    expect(err.message).not.toContain('space_grants_pending_unique');
    expect(databaseErrorText(err)).toContain('space_grants_pending_unique');
  });

  it('keeps the top-level message first so sentinel prefixes still match', () => {
    expect(databaseErrorText(new Error('SLUG_RETIRED:games'))).toMatch(/^SLUG_RETIRED:games/);
  });

  it('stringifies a non-error throw', () => {
    expect(databaseErrorText('boom')).toBe('boom');
  });

  it('terminates on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(databaseErrorText(b).split('\n').length).toBeLessThanOrEqual(5);
  });
});

describe('isDatabaseError', () => {
  it('recognizes a wrapped Postgres failure', () => {
    expect(isDatabaseError(drizzleQueryError('users_email_unique'))).toBe(true);
  });
});

describe('classifyDbError', () => {
  it('classifies a wrapped duplicate as a conflict', () => {
    expect(classifyDbError(drizzleQueryError('users_email_unique'), 'save user').statusCode).toBe(
      409,
    );
  });
});
