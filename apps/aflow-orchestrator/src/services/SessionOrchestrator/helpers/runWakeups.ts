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
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';

/**
 * What runs this session started without waiting have reported, oldest first.
 *
 * The same discipline as the room: uncursored, the recent window every turn,
 * and the conversation store keeps each one exactly once by its event id — so
 * a turn that fails reads them again rather than losing them to a cursor that
 * already moved.
 *
 * A row the store cannot answer for right now is left out of this turn and
 * nothing else is: the turn's input then lacks it, so it still counts as
 * unread and the next settle or event-wake slot delivers it.
 */
export async function readRunWakeups(
  db: PostgresJsDatabase,
  payloadStore: Pick<PayloadStore, 'retrieve' | 'exists'>,
  tenantId: TenantId,
  sessionId: string,
): Promise<WorkflowRunWakeupEntry[]> {
  const rows = await recentRunWakeupRows(db, tenantId, sessionId);

  const oldestFirst = rows.reverse();
  const settled = await Promise.allSettled(
    oldestFirst.map((row) => deliverableRunWakeup(payloadStore, row)),
  );
  const entries: WorkflowRunWakeupEntry[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      if (outcome.value !== null) entries.push(outcome.value);
      return;
    }
    const reason: unknown = outcome.reason;
    getOrchestratorLogger().warn(
      `readRunWakeups: left wakeup ${oldestFirst[index]?.eventId ?? '?'} of ${sessionId} for a later turn: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  });
  return entries;
}

/**
 * Whether the session holds a wakeup the turn that ran on `turnInputRef` did
 * not read.
 *
 * Every turn is handed the recent window, so what a turn read is exactly what
 * its input carried: anything in the window now and not in that input landed
 * after the input was built — while the agent was mid-turn, say.
 *
 * A wakeup counts only if {@link readRunWakeups} would hand it over. One whose
 * envelope has aged out of the payload store or does not parse is never in a
 * turn's input, so counting it would wake the session at every settle and every
 * event-wake slot for as long as it stays in the window. One the store cannot
 * answer for yet does not hide another that is deliverable; only when none is
 * does the store's error reach the caller, since not knowing is not "read".
 */
export async function hasUnreadRunWakeups(
  db: PostgresJsDatabase,
  payloadStore: Pick<PayloadStore, 'retrieve' | 'exists'>,
  tenantId: TenantId,
  sessionId: string,
  turnInputRef: string | undefined,
): Promise<boolean> {
  const rows = await recentRunWakeupRows(db, tenantId, sessionId);
  if (rows.length === 0) return false;
  const read = new Set<string>();
  if (turnInputRef !== undefined) {
    const input: unknown = await payloadStore.retrieve(turnInputRef).catch(() => undefined);
    const handed =
      input !== null && typeof input === 'object'
        ? (input as Record<string, unknown>)['newRunWakeups']
        : undefined;
    if (Array.isArray(handed)) {
      for (const entry of handed as unknown[]) {
        const eventId =
          entry !== null && typeof entry === 'object'
            ? (entry as Record<string, unknown>)['eventId']
            : undefined;
        if (typeof eventId === 'string') read.add(eventId);
      }
    }
  }
  const unread = rows.filter((row) => !read.has(row.eventId));
  if (unread.length === 0) return false;
  const settled = await Promise.allSettled(
    unread.map((row) => deliverableRunWakeup(payloadStore, row)),
  );
  if (settled.some((outcome) => outcome.status === 'fulfilled' && outcome.value !== null)) {
    return true;
  }
  const failed = settled.find((outcome) => outcome.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return false;
}

interface RunWakeupRow {
  eventId: string;
  payloadRef: string | null;
}

/**
 * The wakeup a row carries, or null when it never can be handed over: its
 * envelope is missing, has expired, or does not parse. A store that cannot
 * answer right now throws instead — that says nothing about the envelope, and
 * taking it for gone would mark the wakeup read and drop it for good.
 */
async function deliverableRunWakeup(
  payloadStore: Pick<PayloadStore, 'retrieve' | 'exists'>,
  row: RunWakeupRow,
): Promise<WorkflowRunWakeupEntry | null> {
  if (!row.payloadRef) return null;
  let stored: unknown;
  try {
    stored = await payloadStore.retrieve(row.payloadRef);
  } catch (err) {
    if (err instanceof SyntaxError || !(await payloadStore.exists(row.payloadRef))) return null;
    throw err;
  }
  const parsed = WorkflowRunWakeupEnvelopeSchema.safeParse(stored);
  return parsed.success ? { eventId: row.eventId, envelope: parsed.data } : null;
}

async function recentRunWakeupRows(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: string,
): Promise<RunWakeupRow[]> {
  return withTenantSchema(db, createTenantContext(tenantId), (tx) =>
    tx
      .select({ eventId: eventLog.eventId, payloadRef: eventLog.payloadRef })
      .from(eventLog)
      .where(and(eq(eventLog.sessionId, sessionId), eq(eventLog.eventType, 'WorkflowRunWakeup')))
      .orderBy(desc(eventLog.timestamp))
      .limit(WORKFLOW_RUN_WAKEUP_MAX_ENTRIES),
  );
}
