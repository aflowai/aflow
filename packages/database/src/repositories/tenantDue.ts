/**
 * Reader side of every public due pointer.
 *
 * A claim leases the tenant instead of removing it: the domain's own worker is
 * the only thing that can decide a tenant's work is done, and a claimant that
 * dies before it runs must leave the tenant to the next cycle rather than take
 * its work with it. `SKIP LOCKED` keeps two instances off the same tenant inside
 * a cycle; the lease keeps them off it across cycles.
 */
import type postgres from 'postgres';
import type { TenantId } from '@aflow/schemas';
import { isValidSchemaName, tenantIdToSchemaName } from '../tenant/context.js';
import { tenantDueRecomputeSql, type TenantDuePointer } from '../tenant/tenantDue.js';

export interface TenantDueClaim {
  tenantId: string;
  /**
   * The pointer's arm counter as it stood at the claim. Settling compares
   * against it, so a write that armed the pointer mid-cycle is never
   * overwritten by a recompute that could not have seen it.
   */
  armedSeq: string;
}

export interface TenantDueSettlement {
  /** The tenant had no work left in this domain and its pointer row was removed. */
  drained: boolean;
  /** An arm landed during the cycle, so the recompute was discarded. */
  rearmed: boolean;
}

function schemaFor(tenantId: string): string {
  const schemaName = tenantIdToSchemaName(tenantId as TenantId);
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Refusing to build due-pointer SQL for invalid schema: ${schemaName}`);
  }
  return schemaName;
}

/**
 * Take up to `limit` tenants whose earliest work is already due and hold them
 * for `leaseMs`.
 */
export async function claimDueTenants(
  sqlClient: postgres.Sql,
  pointer: TenantDuePointer,
  args: { limit: number; leaseMs: number; claimToken: string },
): Promise<TenantDueClaim[]> {
  if (args.limit <= 0) return [];
  const rows = await sqlClient.unsafe<Array<{ tenant_id: string; armed_seq: string }>>(
    `
    WITH due AS (
      SELECT tenant_id
        FROM ${pointer.table}
       WHERE due_at <= now()
         AND (lease_until IS NULL OR lease_until <= now())
       ORDER BY due_at
       LIMIT $1::int
         FOR UPDATE SKIP LOCKED
    )
    UPDATE ${pointer.table} d
       SET lease_until = now() + ($2::double precision / 1000) * interval '1 second',
           claimed_by = $3,
           updated_at = now()
      FROM due
     WHERE d.tenant_id = due.tenant_id
    RETURNING d.tenant_id::text AS tenant_id, d.armed_seq::text AS armed_seq
  `,
    [args.limit, args.leaseMs, args.claimToken],
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, armedSeq: row.armed_seq }));
}

/**
 * Move a claimed tenant's pointer to its next real due time, or drop it when
 * nothing is outstanding.
 *
 * The recompute and the write are one statement so they share a snapshot and a
 * row lock: a concurrent arm either lands first and is counted, or waits and
 * then lowers the value this wrote.
 */
export async function settleTenantDue(
  sqlClient: postgres.Sql,
  pointer: TenantDuePointer,
  claim: TenantDueClaim,
  claimToken: string,
): Promise<TenantDueSettlement> {
  const schemaName = schemaFor(claim.tenantId);
  // One statement, so the recompute, the move and the drop share a snapshot and
  // a row lock. Two statements let the lease drop at the end of the first — a
  // second instance then claims the tenant, and the delete lands on a row it is
  // already working. The two branches are mutually exclusive on the same
  // recompute, so only one of them can match.
  const settled = await sqlClient.unsafe<Array<{ moved: number; dropped: number }>>(
    `
    WITH n AS (SELECT ${tenantDueRecomputeSql(pointer, schemaName)} AS next_due),
    moved AS (
      UPDATE ${pointer.table} d
         SET due_at = n.next_due,
             lease_until = NULL,
             claimed_by = NULL,
             updated_at = now()
        FROM n
       WHERE d.tenant_id = $1::uuid
         AND d.claimed_by = $2
         AND d.armed_seq = $3::bigint
         AND n.next_due IS NOT NULL
      RETURNING 1
    ),
    dropped AS (
      DELETE FROM ${pointer.table} d
       USING n
       WHERE d.tenant_id = $1::uuid
         AND d.claimed_by = $2
         AND d.armed_seq = $3::bigint
         AND n.next_due IS NULL
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM moved)::int AS moved,
           (SELECT count(*) FROM dropped)::int AS dropped
  `,
    [claim.tenantId, claimToken, claim.armedSeq],
  );

  const row = settled[0];
  if (!row || (row.moved === 0 && row.dropped === 0)) {
    // Neither branch matched: the arm counter moved, so work landed while this
    // cycle ran. Hand the claim back and let the next one see the newer state.
    await releaseTenantDueClaim(sqlClient, pointer, claim.tenantId, claimToken);
    return { drained: false, rearmed: true };
  }
  return { drained: row.dropped > 0, rearmed: false };
}

/** Hand a claimed tenant back untouched — the cycle ran out of budget. */
export async function releaseTenantDueClaim(
  sqlClient: postgres.Sql,
  pointer: TenantDuePointer,
  tenantId: string,
  claimToken: string,
): Promise<void> {
  await sqlClient.unsafe(
    `UPDATE ${pointer.table}
        SET lease_until = NULL, claimed_by = NULL, updated_at = now()
      WHERE tenant_id = $1::uuid AND claimed_by = $2`,
    [tenantId, claimToken],
  );
}

/**
 * Arm one tenant from its own tables — the same lower-only upsert the trigger
 * performs, driven from a full recompute instead of a single row.
 */
export async function armTenantDueFromTenant(
  sqlClient: postgres.Sql,
  pointer: TenantDuePointer,
  tenantId: string,
): Promise<boolean> {
  const schemaName = schemaFor(tenantId);
  const armed = await sqlClient.unsafe<Array<{ tenant_id: string }>>(
    `
    INSERT INTO ${pointer.table} AS d (tenant_id, due_at, armed_seq)
    SELECT $1::uuid, n.next_due, 1
      FROM (SELECT ${tenantDueRecomputeSql(pointer, schemaName)} AS next_due) n
     WHERE n.next_due IS NOT NULL
    ON CONFLICT (tenant_id) DO UPDATE
       SET due_at = EXCLUDED.due_at,
           armed_seq = d.armed_seq + 1,
           updated_at = now()
     WHERE d.due_at > EXCLUDED.due_at
    RETURNING d.tenant_id::text AS tenant_id
  `,
    [tenantId],
  );
  return armed.length > 0;
}

/**
 * Drop a tenant's pointer rows across every domain. A dropped schema takes its
 * triggers and its rows with it but cannot reach across into the public schema,
 * and a pointer with no schema behind it is claimed and re-claimed for as long
 * as it exists.
 */
export async function clearTenantDue(
  sqlClient: postgres.Sql,
  pointers: readonly TenantDuePointer[],
  tenantId: string,
): Promise<void> {
  for (const pointer of pointers) {
    await sqlClient.unsafe(`DELETE FROM ${pointer.table} WHERE tenant_id = $1::uuid`, [tenantId]);
  }
}
