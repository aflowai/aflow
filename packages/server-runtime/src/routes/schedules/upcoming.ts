import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  agentSchedules,
  createTenantContext,
  withTenantSchema,
  type AgentScheduleRow,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

/** The Workbench section shows this many upcoming schedules at most. */
export const UPCOMING_SCHEDULE_LIST_LIMIT = 20;

/**
 * The space's schedules that will fire again, soonest first: active, with a
 * next firing ahead of `now` and no end before it. Who created a schedule plays
 * no part. An operator-created one runs on its own as much as an agent-armed
 * one does.
 *
 * A renewal expires its predecessor when it is written, so a chain shows once,
 * as its newest renewal, with no walk of the chain.
 */
export async function readUpcomingSchedules(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  now: number = Date.now(),
): Promise<AgentScheduleRow[]> {
  const at = new Date(now);
  return withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.spaceId, spaceId),
          eq(agentSchedules.status, 'active'),
          gt(agentSchedules.nextFireAt, at),
          or(isNull(agentSchedules.expiresAt), gt(agentSchedules.expiresAt, at)),
        ),
      )
      .orderBy(asc(agentSchedules.nextFireAt), asc(agentSchedules.id))
      .limit(UPCOMING_SCHEDULE_LIST_LIMIT),
  );
}
