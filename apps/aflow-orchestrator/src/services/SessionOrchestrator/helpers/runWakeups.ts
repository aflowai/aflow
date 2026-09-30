import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, eventLog, withTenantSchema } from '@aflow/database';
import {
  WORKFLOW_RUN_WAKEUP_MAX_ENTRIES,
  WorkflowRunWakeupEnvelopeSchema,
  type TenantId,
  type WorkflowRunWakeupEntry,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * What runs this session started without waiting have reported, oldest first.
 *
 * The same discipline as the room: uncursored, the recent window every turn,
 * and the conversation store keeps each one exactly once by its event id — so
 * a turn that fails reads them again rather than losing them to a cursor that
 * already moved.
 */
export async function readRunWakeups(
  db: PostgresJsDatabase,
  payloadStore: Pick<PayloadStore, 'retrieve'>,
  tenantId: TenantId,
  sessionId: string,
): Promise<WorkflowRunWakeupEntry[]> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), (tx) =>
    tx
      .select({ eventId: eventLog.eventId, payloadRef: eventLog.payloadRef })
      .from(eventLog)
      .where(and(eq(eventLog.sessionId, sessionId), eq(eventLog.eventType, 'WorkflowRunWakeup')))
      .orderBy(desc(eventLog.timestamp))
      .limit(WORKFLOW_RUN_WAKEUP_MAX_ENTRIES),
  );

  const entries = await Promise.all(
    rows.reverse().map(async (row): Promise<WorkflowRunWakeupEntry | null> => {
      if (!row.payloadRef) return null;
      const parsed = WorkflowRunWakeupEnvelopeSchema.safeParse(
        await payloadStore.retrieve(row.payloadRef).catch(() => undefined),
      );
      return parsed.success ? { eventId: row.eventId, envelope: parsed.data } : null;
    }),
  );
  return entries.filter((entry): entry is WorkflowRunWakeupEntry => entry !== null);
}
