import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  agentSchedules,
  createTenantContext,
  withTenantSchema,
  type AgentScheduleRow,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';

/**
 * The Workbench section shows this many upcoming schedules at most. No ceiling
 * bounds how many schedules an operator creates, so the read also counts them
 * all and the section says how many the cap leaves out.
 */
export const UPCOMING_SCHEDULE_LIST_LIMIT = 20;

export interface UpcomingSchedules {
  /** The soonest `UPCOMING_SCHEDULE_LIST_LIMIT` schedules, soonest first. */
  schedules: AgentScheduleRow[];
  /** Every upcoming schedule in the space, the listed ones included. */
  total: number;
}

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
): Promise<UpcomingSchedules> {
  const at = new Date(now);
  const upcoming = and(
    eq(agentSchedules.spaceId, spaceId),
    eq(agentSchedules.status, 'active'),
    gt(agentSchedules.nextFireAt, at),
    or(isNull(agentSchedules.expiresAt), gt(agentSchedules.expiresAt, at)),
  );
  return withTenantSchema(db, createTenantContext(tenantId), async (tx) => {
    const schedules = await tx
      .select()
      .from(agentSchedules)
      .where(upcoming)
      .orderBy(asc(agentSchedules.nextFireAt), asc(agentSchedules.id))
      .limit(UPCOMING_SCHEDULE_LIST_LIMIT);
    // A short page holds them all, so only a full one needs the count.
    if (schedules.length < UPCOMING_SCHEDULE_LIST_LIMIT) {
      return { schedules, total: schedules.length };
    }
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(agentSchedules)
      .where(upcoming);
    return { schedules, total: Math.max(counted?.total ?? 0, schedules.length) };
  });
}
