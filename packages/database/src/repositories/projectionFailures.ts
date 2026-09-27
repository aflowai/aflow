/**
 * Reader and writer sides of the projection failure record.
 *
 * The write returns whether the row now stands evicted, because that answer is
 * what authorises dropping the candidate: an eviction whose record did not land
 * is the "no record anywhere" outcome the table exists to prevent, and when the
 * failure cause is Postgres itself the correct behaviour is to leave the
 * candidate armed rather than to drop it blind.
 */
import type postgres from 'postgres';
import { PROJECTION_FAILURES_TABLE } from '../tenant/projectionFailures.js';

export type ProjectionFailureReason = 'projection_error' | 'state_missing' | 'state_corrupt';

export interface ProjectionFailureRow {
  tenantId: string;
  sessionId: string;
  reason: ProjectionFailureReason;
  attempts: number;
  lastError: string | null;
  evictedAt: Date | null;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

export interface RecordProjectionFailureArgs {
  tenantId: string;
  sessionId: string;
  reason: ProjectionFailureReason;
  error?: string | undefined;
  /**
   * Attempt count at which the candidate may be dropped. One for a session with
   * nothing left to project from — there is no later attempt that could go
   * better.
   */
  evictAtAttempts: number;
}

/** Count this failure and report whether the session now stands evicted. */
export async function recordProjectionFailure(
  sqlClient: postgres.Sql,
  args: RecordProjectionFailureArgs,
): Promise<{ attempts: number; evicted: boolean }> {
  const rows = await sqlClient.unsafe<Array<{ attempts: number; evicted: boolean }>>(
    `INSERT INTO ${PROJECTION_FAILURES_TABLE} AS f
       (tenant_id, session_id, reason, attempts, last_error, evicted_at)
     VALUES ($1::uuid, $2::uuid, $3, 1, $4,
             CASE WHEN 1 >= $5::int THEN now() END)
     ON CONFLICT (tenant_id, session_id) DO UPDATE
        SET attempts = f.attempts + 1,
            reason = EXCLUDED.reason,
            last_error = EXCLUDED.last_error,
            last_failed_at = now(),
            -- Recomputed from this call's ceiling, not carried forward. A
            -- session evicted once under the immediate ceiling can be
            -- resurrected — a resume rehydrates its hot state and re-arms the
            -- candidate — and preserving the old timestamp answered "evicted"
            -- for every later failure, collapsing the ten-attempt budget to one
            -- for the rest of that session's life.
            evicted_at = CASE
              WHEN f.attempts + 1 >= $5::int THEN now()
              ELSE NULL
            END
     RETURNING f.attempts, (f.evicted_at IS NOT NULL) AS evicted`,
    [args.tenantId, args.sessionId, args.reason, args.error ?? null, args.evictAtAttempts],
  );
  const row = rows[0];
  if (!row) throw new Error(`projection failure record for ${args.sessionId} was not written`);
  return { attempts: row.attempts, evicted: row.evicted };
}

/** Retire the record — this session's durable copy is current again. */
export async function clearProjectionFailure(
  sqlClient: postgres.Sql,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await sqlClient.unsafe(
    `DELETE FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = $1::uuid AND session_id = $2::uuid`,
    [tenantId, sessionId],
  );
}

/** Sessions whose durable copy is behind, worst first. Operator read. */
export async function listProjectionFailures(
  sqlClient: postgres.Sql,
  args: { limit: number; evictedOnly?: boolean } = { limit: 100 },
): Promise<ProjectionFailureRow[]> {
  const rows = await sqlClient.unsafe<
    Array<{
      tenant_id: string;
      session_id: string;
      reason: ProjectionFailureReason;
      attempts: number;
      last_error: string | null;
      evicted_at: Date | null;
      first_failed_at: Date;
      last_failed_at: Date;
    }>
  >(
    `SELECT tenant_id::text AS tenant_id, session_id::text AS session_id, reason, attempts,
            last_error, evicted_at, first_failed_at, last_failed_at
       FROM ${PROJECTION_FAILURES_TABLE}
      ${args.evictedOnly === true ? 'WHERE evicted_at IS NOT NULL' : ''}
      ORDER BY last_failed_at DESC
      LIMIT $1::int`,
    [args.limit],
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    reason: row.reason,
    attempts: row.attempts,
    lastError: row.last_error,
    evictedAt: row.evicted_at,
    firstFailedAt: row.first_failed_at,
    lastFailedAt: row.last_failed_at,
  }));
}
