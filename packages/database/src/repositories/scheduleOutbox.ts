/**
 * Reader and writer sides of the schedule dispatch outbox.
 *
 * A due-time dispatch shares the transaction that advances the schedule.
 * An event wake inserts its occurrence directly: no schedule row advances.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { SCHEDULE_DISPATCH_OUTBOX_TABLE } from '../tenant/scheduleOutbox.js';

/**
 * What one occurrence carries to its dispatch: the schedule as it stood when
 * the occurrence was recorded, and the input resolved for it. Every producer
 * of an occurrence — a due time, a source run's end, a resident's wake —
 * writes this shape, and the drain lowers it.
 */
export interface ScheduleDispatchItem extends Record<string, unknown> {
  tenantId: string;
  scheduleId: string;
  scheduleName: string;
  schemaName: string;
  spaceId: string;
  action: string;
  targetKind: string | null;
  targetSystemRole: string | null;
  targetAgentId: string | null;
  agentVersion: string | null;
  targetSessionId: string | null;
  targetStepExecutionId: string | null;
  resolvedInput: Record<string, unknown>;
  firingCount: number;
  idempotencyKey: string;
  creatorUserId: string | null;
  creatorTenantRole: string | null;
  creatorSpaceRole: string | null;
}

const SCHEDULE_RUN_NAMESPACE = 'aflow:schedule-occurrence';

/**
 * The run id for one occurrence, derived from the occurrence itself.
 *
 * A retry after an ambiguous emit must present the same id or it cannot be
 * deduplicated: `addControlMessage` is a single XADD, and a failover that drops
 * the reply after the server applied it looks exactly like a failure. Minting a
 * fresh id per attempt turns that ambiguity into two runs for one occurrence —
 * `startRun` deduplicates on the run id and has nothing else to go on.
 */
export function scheduleOccurrenceRunId(idempotencyKey: string): string {
  const h = createHash('sha1').update(SCHEDULE_RUN_NAMESPACE).update(idempotencyKey).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
  tx: postgres.TransactionSql | PostgresJsDatabase,
  row: Omit<ScheduleDispatchRow, 'attempts'>,
): Promise<void> {
  if ('execute' in tx) {
    await tx.execute(sql`INSERT INTO ${sql.raw(SCHEDULE_DISPATCH_OUTBOX_TABLE)}
      (idempotency_key, tenant_id, schedule_id, dispatch)
      VALUES (${row.idempotencyKey}, ${row.tenantId}::uuid, ${row.scheduleId}::uuid, ${JSON.stringify(row.dispatch)}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING`);
    return;
  }
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
