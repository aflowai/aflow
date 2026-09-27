import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, eq, min, sql } from 'drizzle-orm';
import {
  createTenantContext,
  eventLog,
  withTenantSchema,
  SIMULATED_BINDING_EXPRESSION,
  SIMULATED_EVENT_PREDICATE,
} from '@aflow/database';
import type { SessionId, TenantId } from '@aflow/schemas';

/**
 * Which bindings answered this session with a simulation, oldest first.
 *
 * The run banner's rule is that one fabricated fact makes the whole room a
 * rehearsal and keeps it one, so the answer cannot come from whichever events
 * the mount happens to fold: a session that rehearsed early and not since would
 * drop its own banner as its history grew past the page. It is read from the
 * durable log, where the claim is as old as the session.
 *
 * Both expressions come from the index definition itself, so the predicate the
 * planner matches on cannot drift from the one it was built with. Partial on
 * the flag, so the read touches only the events carrying it rather than the
 * session's history — 151.9 ms and 76,784 buffers before the index, 0.07 ms and
 * one buffer after, on the same 83,468-event session.
 */
export async function readSimulatedBindings(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: SessionId,
): Promise<string[]> {
  const bindingId = sql<string | null>`${sql.raw(SIMULATED_BINDING_EXPRESSION)}`;
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ bindingId })
      .from(eventLog)
      .where(and(eq(eventLog.sessionId, sessionId), sql.raw(SIMULATED_EVENT_PREDICATE)))
      .groupBy(bindingId)
      .orderBy(asc(min(eventLog.sequenceNumber))),
  );
  return rows.map((r) => r.bindingId).filter((id): id is string => typeof id === 'string' && !!id);
}
