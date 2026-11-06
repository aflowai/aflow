import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  agentSchedules,
  createTenantContext,
  withTenantSchema,
  type AgentScheduleRow,
} from '@aflow/database';
import type { ScheduleKind, ScheduleStatus, TenantId } from '@aflow/schemas';

export interface ScheduleListFilters {
  status?: ScheduleStatus | undefined;
  flowId?: string | undefined;
  kind?: ScheduleKind | undefined;
  limit: number;
}

export interface ScheduleListPage {
  rows: AgentScheduleRow[];
  nextCursor: string | null;
}

/** Where a page ends: the last row's rank, its creation to the millisecond, its id. */
export interface ScheduleListCursor {
  rank: 0 | 1;
  createdAtMs: number;
  id: string;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_SHAPE = /^([01])\.(\d{1,16})\.([0-9a-f-]{36})$/i;

export function encodeScheduleListCursor(cursor: ScheduleListCursor): string {
  return `${String(cursor.rank)}.${String(cursor.createdAtMs)}.${cursor.id}`;
}

/** Null where the text is no cursor this read wrote. */
export function decodeScheduleListCursor(text: string): ScheduleListCursor | null {
  const match = CURSOR_SHAPE.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { rank: match[1] === '0' ? 0 : 1, createdAtMs: Number(match[2]), id: match[3] };
}

/**
 * 0 for a row the Triggers page lists among those that can still run, 1 for
 * an expired one. It matches `scheduleState` in the web's `schedule-card.tsx`:
 * an active row whose end has passed reads as expired, and a paused row does
 * not.
 */
function scheduleListRank(at: Date): SQL<number> {
  return sql<number>`(case when ${agentSchedules.status} = 'paused' or (${agentSchedules.status} = 'active' and (${agentSchedules.expiresAt} is null or ${agentSchedules.expiresAt} > ${at.toISOString()}::timestamptz)) then 0 else 1 end)`;
}

/** The cursor compares to the millisecond, as a JavaScript date holds it. */
const createdAtMs = sql`date_trunc('milliseconds', ${agentSchedules.createdAt})`;

/**
 * A page of the space's schedules: every row that can still run first, newest
 * first, then the expired ones, newest first. A renewing cron leaves one
 * expired row behind per renewal. Ordered by creation alone, those rows fill
 * the first page and push off the schedules that will fire, which the
 * Workbench sends the operator here to find.
 *
 * The rank is read against `now`, so a row that expires between two pages can
 * move from the first group to the second.
 */
export async function readScheduleListPage(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  filters: ScheduleListFilters,
  cursor: ScheduleListCursor | null,
  now: number = Date.now(),
): Promise<ScheduleListPage> {
  const rank = scheduleListRank(new Date(now));
  const conditions: SQL[] = [eq(agentSchedules.spaceId, spaceId)];
  conditions.push(
    filters.status
      ? eq(agentSchedules.status, filters.status)
      : sql`${agentSchedules.status} != 'deleted'`,
  );
  if (filters.flowId) {
    conditions.push(
      UUID_SHAPE.test(filters.flowId)
        ? eq(agentSchedules.targetAgentId, filters.flowId)
        : eq(agentSchedules.targetSystemRole, filters.flowId),
    );
  }
  if (filters.kind) conditions.push(eq(agentSchedules.kind, filters.kind));
  if (cursor) {
    const createdAt = sql`${new Date(cursor.createdAtMs).toISOString()}::timestamptz`;
    conditions.push(
      sql`(${rank} > ${cursor.rank} or (${rank} = ${cursor.rank} and (${createdAtMs} < ${createdAt} or (${createdAtMs} = ${createdAt} and ${agentSchedules.id} < ${cursor.id}))))`,
    );
  }

  const rows = await withTenantSchema(db, createTenantContext(tenantId), (tx) =>
    tx
      .select({ row: agentSchedules, rank })
      .from(agentSchedules)
      .where(and(...conditions))
      .orderBy(rank, desc(createdAtMs), desc(agentSchedules.id))
      .limit(filters.limit + 1),
  );

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((entry) => entry.row),
    nextCursor:
      hasMore && last
        ? encodeScheduleListCursor({
            rank: String(last.rank) === '0' ? 0 : 1,
            createdAtMs: last.row.createdAt.getTime(),
            id: last.row.id,
          })
        : null,
  };
}
