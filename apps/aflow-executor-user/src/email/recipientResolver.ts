/**
 * Recipient resolution — resolves the run initiator's email from the database.
 *
 * Resolution path:
 * 1. Read createdBy from SessionHotState
 * 2. Load public.users row
 * 3. Require kind='human', email IS NOT NULL, status='active'
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { users } from '@aflow/database';
import type { Redis } from 'ioredis';
import { getSessionState } from '@aflow/redis';

export interface ResolvedRecipient {
  userId: string;
  email: string;
  displayName: string;
}

export type RecipientError =
  | 'USER_NOT_FOUND'
  | 'USER_NOT_HUMAN'
  | 'USER_EMAIL_UNAVAILABLE'
  | 'USER_DEACTIVATED'
  | 'CREATED_BY_MISSING';

export type RecipientResult =
  { ok: true; recipient: ResolvedRecipient } | { ok: false; code: RecipientError; message: string };

/**
 * Resolve the email recipient for a given run.
 *
 * Returns the human user who started the run, validated for:
 * - existence
 * - kind = 'human'
 * - active status
 * - non-null email
 */
export async function resolveRecipient(
  redis: Redis,
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<RecipientResult> {
  // Step 1: Get createdBy from run hot state
  const runState = await getSessionState(redis, tenantId, runId);
  if (!runState) {
    return {
      ok: false,
      code: 'CREATED_BY_MISSING',
      message: `Run ${runId} not found in hot state`,
    };
  }

  const createdBy = runState.createdBy;
  if (!createdBy) {
    return {
      ok: false,
      code: 'CREATED_BY_MISSING',
      message: 'Run has no createdBy — cannot determine email recipient',
    };
  }

  // Step 2: Load user from database
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      kind: users.kind,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, createdBy))
    .limit(1);

  const user = rows[0];
  if (!user) {
    return {
      ok: false,
      code: 'USER_NOT_FOUND',
      message: `User ${createdBy} not found`,
    };
  }

  // Step 3: Validate constraints
  if (user.kind !== 'human') {
    return {
      ok: false,
      code: 'USER_NOT_HUMAN',
      message: `User ${createdBy} is a ${user.kind}, not a human — cannot send email`,
    };
  }

  if (user.status !== 'active') {
    return {
      ok: false,
      code: 'USER_DEACTIVATED',
      message: `User ${createdBy} is ${user.status} — cannot send email to deactivated users`,
    };
  }

  if (!user.email) {
    return {
      ok: false,
      code: 'USER_EMAIL_UNAVAILABLE',
      message: `User ${createdBy} has no email on file`,
    };
  }

  return {
    ok: true,
    recipient: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
    },
  };
}
