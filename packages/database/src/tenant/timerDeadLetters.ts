/**
 * The durable record of a timer wake that could not be delivered or
 * dispositioned.
 *
 * A timer past its redelivery budget is surfaced for a terminal disposition;
 * one whose disposition itself keeps failing is retired here — never merely
 * deleted, because the payload is the only copy of the owed wake, and a
 * Redis-side list is neither durable nor queryable and had to be bounded by
 * trimming away exactly the records it existed to keep.
 *
 * Keyed by the timer's stable storage identity: the archive commits before the
 * Redis acknowledgement, so a crash between the two redelivers the same timer
 * and the retry must land on the existing row — a second row would make a
 * replay of this table wake the same step twice.
 *
 * Public rather than per-tenant, like `projection_failures`: the timer loop
 * holds a tenant id and nothing else — sometimes not even that, for a payload
 * the schema no longer parses — and the write must be possible even when
 * tenant-schema work is what keeps failing. Rows are replayable by handing
 * `payload` back to `scheduleShardTimer`.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export const TIMER_DEAD_LETTERS_TABLE = 'public.timer_dead_letters';

export function timerDeadLettersDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TIMER_DEAD_LETTERS_TABLE} (
      timer_id          TEXT PRIMARY KEY,
      tenant_id         UUID,
      session_id        UUID,
      step_execution_id UUID,
      reason            TEXT NOT NULL,
      claims            INT NOT NULL,
      payload           JSONB NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_timer_dead_letters_tenant
      ON ${TIMER_DEAD_LETTERS_TABLE} (tenant_id, created_at);
  `;
}

export interface TimerDeadLetterEntry {
  timerId: string;
  tenantId: string | null;
  sessionId: string | null;
  stepExecutionId: string | null;
  reason: string;
  claims: number;
  payload: unknown;
}

export async function insertTimerDeadLetter(
  db: PostgresJsDatabase,
  entry: TimerDeadLetterEntry,
): Promise<void> {
  // Postgres rejects \u0000 inside jsonb, and this archive is the terminal
  // backstop for payloads of every provenance — a value that cannot cast must
  // degrade, never make the insert throw on each redelivery forever.
  const payloadJson = JSON.stringify(entry.payload).replaceAll('\\u0000', '');
  await db.execute(sql`
    INSERT INTO public.timer_dead_letters
      (timer_id, tenant_id, session_id, step_execution_id, reason, claims, payload)
    VALUES (${entry.timerId}, ${entry.tenantId}::uuid, ${entry.sessionId}::uuid,
            ${entry.stepExecutionId}::uuid, ${entry.reason}, ${entry.claims},
            ${payloadJson}::jsonb)
    ON CONFLICT (timer_id) DO UPDATE
      SET claims = EXCLUDED.claims, updated_at = now()
  `);
}
