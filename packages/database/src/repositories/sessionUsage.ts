import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant.js';
import { eventLog } from '../schema/index.js';

export interface SessionUsage {
  /** Count of completed steps (StepSucceeded events) for the session. */
  stepCount: number;
  /** Sum of per-step `usage.totalTokens`. */
  totalTokens: number;
  /** Sum of per-step `usage.totalCostUsd`, in cents. */
  totalCostCents: number;
}

/**
 * Resolve usage for the given session ids by aggregating their `StepSucceeded`
 * events. Sessions with no such events are absent from the map. De-dupes +
 * drops empty ids; returns an empty map for empty input without querying.
 */
export async function readSessionUsage(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, SessionUsage>> {
  const ids = [...new Set(sessionIds.filter((id) => id.length > 0))];
  const out = new Map<string, SessionUsage>();
  if (ids.length === 0) return out;
  const ctx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, ctx, async (tx) => {
    const rows = await tx
      .select({
        sessionId: eventLog.sessionId,
        stepCount: sql<number>`count(*)::int`,
        totalTokens: sql<number>`coalesce(sum((${eventLog.envelope} -> 'usage' ->> 'totalTokens')::int), 0)::int`,
        totalCostUsd: sql<string>`coalesce(sum((${eventLog.envelope} -> 'usage' ->> 'totalCostUsd')::numeric), 0)`,
      })
      .from(eventLog)
      .where(and(inArray(eventLog.sessionId, ids), eq(eventLog.eventType, 'StepSucceeded')))
      .groupBy(eventLog.sessionId);
    for (const r of rows) {
      const usd = Number(r.totalCostUsd);
      out.set(r.sessionId, {
        stepCount: r.stepCount,
        totalTokens: r.totalTokens,
        // Convert summed USD to cents; keep 4 decimal places to match sessions.total_cost_cents.
        totalCostCents: Math.round((Number.isFinite(usd) ? usd : 0) * 100 * 10_000) / 10_000,
      });
    }
  });
  return out;
}
