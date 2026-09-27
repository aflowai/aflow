/**
 * The dead-letter archive commits before the Redis acknowledgement, so a crash
 * between the two redelivers the same timer — the retry must land on the
 * existing row, or a replay of this table would wake the same step twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDatabase, insertTimerDeadLetter, TIMER_DEAD_LETTERS_TABLE } from '@aflow/database';

const DATABASE_URL = process.env['DATABASE_URL'];

let handle: { sql: postgres.Sql; close: () => Promise<void> } | undefined;

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass('public.timer_dead_letters') IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

const TIMER_ID = `dead-letter-test|retry|2|${Date.now()}`;

describe.skipIf(!READY)('timer dead letter archive', () => {
  const sql = (): postgres.Sql => handle!.sql;

  afterAll(async () => {
    if (!handle) return;
    await sql().unsafe(`DELETE FROM ${TIMER_DEAD_LETTERS_TABLE} WHERE timer_id = $1`, [TIMER_ID]);
    await handle.close();
  });

  beforeAll(async () => {
    await sql().unsafe(`DELETE FROM ${TIMER_DEAD_LETTERS_TABLE} WHERE timer_id = $1`, [TIMER_ID]);
  });

  it('a redelivered archive lands on the existing row, never a second one', async () => {
    const db = drizzle(sql());
    const entry = {
      timerId: TIMER_ID,
      tenantId: null,
      sessionId: null,
      stepExecutionId: null,
      reason: 'retry',
      claims: 11,
      payload: { synthetic: true },
    };

    await insertTimerDeadLetter(db, entry);
    // The ack was lost; the same timer is redelivered with a higher count.
    await insertTimerDeadLetter(db, { ...entry, claims: 12 });

    const rows = await sql().unsafe<Array<{ claims: number }>>(
      `SELECT claims FROM ${TIMER_DEAD_LETTERS_TABLE} WHERE timer_id = $1`,
      [TIMER_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.claims).toBe(12);
  });
});
