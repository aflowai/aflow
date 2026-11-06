/**
 * Expired renewals cannot crowd the schedules that will fire off the Triggers
 * page's first page. The order lives in the query, and a fake runs no query.
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
import type { TenantId } from '@aflow/schemas';
import { readScheduleListPage, decodeScheduleListCursor } from './list.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '7a110000-0000-4000-8000-0000000003b2';
const MINUTE = 60_000;
const PAGE = 100;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('readScheduleListPage (real DB)', () => {
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
      ...overrides,
    };
  }

  async function insert(rows: NewAgentScheduleRow[]): Promise<void> {
    await withTenantSchema(db, tenantCtx, (tx) => tx.insert(agentSchedules).values(rows));
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'agent_schedules'
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

  it('lists every row that can still run on the first page under newer expired renewals', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip();
      return;
    }
    const now = Date.now();
    const old = now - 3 * 24 * 60 * MINUTE;
    // Created first, so a page ordered by creation alone would cut all three.
    const runnable = [
      row({ name: 'Nightly report', status: 'active', createdAt: new Date(old) }),
      row({ name: 'Paused digest', status: 'paused', createdAt: new Date(old + MINUTE) }),
      row({
        name: 'Ends tomorrow',
        status: 'active',
        expiresAt: new Date(now + 24 * 60 * MINUTE),
        createdAt: new Date(old + 2 * MINUTE),
      }),
    ];
    // An active row whose end has passed reads as expired, as the page reads it.
    const lapsed = row({
      name: 'Lapsed',
      status: 'active',
      expiresAt: new Date(now - MINUTE),
      createdAt: new Date(now - 2 * MINUTE),
    });
    const renewals = Array.from({ length: PAGE + 20 }, (_, i) =>
      row({ createdAt: new Date(old + (i + 10) * 5 * MINUTE) }),
    );
    await insert([...runnable, lapsed, ...renewals]);

    const first = await readScheduleListPage(db, TENANT_ID, SPACE, { limit: PAGE }, null, now);

    expect(first.rows).toHaveLength(PAGE);
    expect(first.rows.slice(0, 3).map((r) => r.name)).toEqual([
      'Ends tomorrow',
      'Paused digest',
      'Nightly report',
    ]);
    expect(first.rows[3]?.id).toBe(lapsed.id);
    expect(first.nextCursor).not.toBeNull();

    const second = await readScheduleListPage(
      db,
      TENANT_ID,
      SPACE,
      { limit: PAGE },
      decodeScheduleListCursor(first.nextCursor ?? ''),
      now,
    );
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(second.nextCursor).toBeNull();
    expect(seen.size).toBe(runnable.length + 1 + renewals.length);
  });
});
