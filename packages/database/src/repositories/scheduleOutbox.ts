/**
 * Reader and writer sides of the schedule dispatch outbox.
 *
 * Writing is always inside the caller's transaction — the point of the outbox
 * is that the row and the schedule advance commit together — so the insert
 * takes the transaction handle rather than the pool.
 */
import type postgres from 'postgres';
import { SCHEDULE_DISPATCH_OUTBOX_TABLE } from '../tenant/scheduleOutbox.js';

export interface ScheduleDispatchRow {
  idempotencyKey: string;
  tenantId: string;
  scheduleId: string;
  dispatch: Record<string, unknown>;
  attempts: number;
}

/**
 * Record one occurrence for dispatch, inside the transaction that advances the
 * schedule.
 *
 * `DO NOTHING` on conflict because the key is the occurrence: a retry that
 * recomputed the same firing count is the same occurrence, and inserting it
 * twice is the double-fire this table exists to prevent.
 */
export async function insertScheduleDispatch(
  tx: postgres.TransactionSql,
  row: Omit<ScheduleDispatchRow, 'attempts'>,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
       (idempotency_key, tenant_id, schedule_id, dispatch)
     VALUES ($1, $2::uuid, $3::uuid, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [row.idempotencyKey, row.tenantId, row.scheduleId, JSON.stringify(row.dispatch)],
  );
}

/** Take up to `limit` undispatched occurrences and hold them for `leaseMs`. */
export async function claimScheduleDispatches(
  sqlClient: postgres.Sql,
  args: { limit: number; leaseMs: number; claimToken: string },
): Promise<ScheduleDispatchRow[]> {
  if (args.limit <= 0) return [];
  const rows = await sqlClient.unsafe<
    Array<{
      idempotency_key: string;
      tenant_id: string;
      schedule_id: string;
      dispatch: Record<string, unknown>;
      attempts: number;
    }>
  >(
    `
    WITH ready AS (
      SELECT idempotency_key
        FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
       WHERE lease_until IS NULL OR lease_until <= now()
       ORDER BY created_at
       LIMIT $1::int
         FOR UPDATE SKIP LOCKED
    )
    UPDATE ${SCHEDULE_DISPATCH_OUTBOX_TABLE} o
       SET lease_until = now() + ($2::double precision / 1000) * interval '1 second',
           claimed_by = $3,
           attempts = o.attempts + 1
      FROM ready
     WHERE o.idempotency_key = ready.idempotency_key
    RETURNING o.idempotency_key, o.tenant_id::text AS tenant_id,
              o.schedule_id::text AS schedule_id, o.dispatch, o.attempts
  `,
    [args.limit, args.leaseMs, args.claimToken],
  );
  return rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id,
    scheduleId: row.schedule_id,
    dispatch: row.dispatch,
    attempts: row.attempts,
  }));
}

/**
 * Retire an occurrence — emitted, or refused for a reason that will not change.
 *
 * Guarded by the claim token so a drain whose lease expired mid-flight cannot
 * delete a row a later claimant is already working.
 */
export async function deleteScheduleDispatch(
  sqlClient: postgres.Sql,
  idempotencyKey: string,
  claimToken: string,
): Promise<void> {
  await sqlClient.unsafe(
    `DELETE FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
      WHERE idempotency_key = $1 AND claimed_by = $2`,
    [idempotencyKey, claimToken],
  );
}

/**
 * Hand an occurrence back for a later attempt, recording why.
 *
 * The lease is the backoff: pushing it out is what keeps the row invisible for
 * the delay without inventing a second due index for retries.
 */
export async function releaseScheduleDispatch(
  sqlClient: postgres.Sql,
  idempotencyKey: string,
  claimToken: string,
  args: { retryAfterMs: number; error?: string },
): Promise<void> {
  await sqlClient.unsafe(
    `UPDATE ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
        SET lease_until = now() + ($3::double precision / 1000) * interval '1 second',
            claimed_by = NULL,
            last_error = $4
      WHERE idempotency_key = $1 AND claimed_by = $2`,
    [idempotencyKey, claimToken, args.retryAfterMs, args.error ?? null],
  );
}

/** How many occurrences are waiting. Operator/diagnostic read, not a hot path. */
export async function countScheduleDispatches(sqlClient: postgres.Sql): Promise<number> {
  const rows = await sqlClient.unsafe<Array<{ count: string }>>(
    `SELECT count(*)::text AS count FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE}`,
  );
  return Number(rows[0]?.count ?? 0);
}
