/**
 * The chat schedule read is bounded by the lane's limit however many renewals a
 * chain has written, and it reads each chain's newest renewal without walking
 * the chain. The bound lives in the query, and a fake runs no query.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestContext } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentSchedules,
  createDatabase,
  createTenantContext,
  withTenantSchema,
  type NewAgentScheduleRow,
} from '@aflow/database';
import { CHAT_SCHEDULE_LIST_LIMIT, type TenantId } from '@aflow/schemas';
import { readChatScheduleChains } from './triggerArmedSource.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '7a110000-0000-4000-8000-0000000003a1';
const ARMING_SESSION = 'f0000000-0000-4000-8000-0000000003a1';
const MINUTE = 60_000;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('readChatScheduleChains (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const tenantCtx = createTenantContext(TENANT_ID);
  let schemaReady = false;

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.delete(agentSchedules).where(eq(agentSchedules.spaceId, SPACE)),
    );
  }

  /** No next firing, so a running orchestrator never fires these. */
  function row(overrides: Partial<NewAgentScheduleRow>): NewAgentScheduleRow {
    return {
      id: randomUUID(),
      spaceId: SPACE,
      name: 'Local PR Shepherd',
      kind: 'cron',
      cronExpression: '*/5 * * * *',
      status: 'expired',
      nextFireAt: null,
      createdBySessionId: ARMING_SESSION,
      ...overrides,
    };
  }

  /** An arrival and `renewals` renewals after it, five minutes apart. */
  function chainOf(start: number, renewals: number): NewAgentScheduleRow[] {
    const arrival = row({ createdAt: new Date(start) });
    const rows = [arrival];
    for (let i = 1; i <= renewals; i++) {
      const previous = rows[rows.length - 1];
      rows.push(
        row({
          renewsScheduleId: previous?.id ?? null,
          originalScheduleId: arrival.id ?? null,
          createdAt: new Date(start + i * 5 * MINUTE),
        }),
      );
    }
    return rows;
  }

  async function insert(rows: NewAgentScheduleRow[]): Promise<void> {
    await withTenantSchema(db, tenantCtx, (tx) => tx.insert(agentSchedules).values(rows));
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'agent_schedules'
          AND column_name = 'original_schedule_id'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
  });

  beforeEach(async () => {
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('returns at most the limit with more renewals than the limit', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip();
      return;
    }
    const start = Date.now() - 2 * 24 * 60 * MINUTE;
    const shepherd = chainOf(start, CHAT_SCHEDULE_LIST_LIMIT * 3);
    const others = Array.from({ length: CHAT_SCHEDULE_LIST_LIMIT + 5 }, (_, i) =>
      row({ name: `Reminder ${i}`, createdAt: new Date(start - (i + 1) * MINUTE) }),
    );
    await insert([...shepherd, ...others]);

    const chains = await readChatScheduleChains(db, TENANT_ID, SPACE);

    expect(chains).toHaveLength(CHAT_SCHEDULE_LIST_LIMIT);
    expect(chains.every((c) => c.arrival.renewsScheduleId === null)).toBe(true);
    expect(chains[0]?.arrival.id).toBe(shepherd[0]?.id);
    expect(chains[0]?.current.id).toBe(shepherd[shepherd.length - 1]?.id);
  });

  it('reads one chain as its newest renewal that is not deleted', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip();
      return;
    }
    const shepherd = chainOf(Date.now() - 60 * MINUTE, 3);
    const last = shepherd[3];
    if (last) last.status = 'deleted';
    await insert(shepherd);

    const chains = await readChatScheduleChains(db, TENANT_ID, SPACE);

    expect(chains.map((c) => [c.arrival.id, c.current.id])).toEqual([
      [shepherd[0]?.id, shepherd[2]?.id],
    ]);
  });

  it('passes over a deleted renewal to a live one after it', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip();
      return;
    }
    const shepherd = chainOf(Date.now() - 60 * MINUTE, 3);
    const deleted = shepherd[2];
    if (deleted) deleted.status = 'deleted';
    await insert(shepherd);

    const chains = await readChatScheduleChains(db, TENANT_ID, SPACE);

    expect(chains.map((c) => [c.arrival.id, c.current.id])).toEqual([
      [shepherd[0]?.id, shepherd[3]?.id],
    ]);
  });
});
