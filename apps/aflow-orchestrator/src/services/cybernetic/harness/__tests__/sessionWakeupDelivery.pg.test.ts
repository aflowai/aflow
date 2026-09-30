/**
 * A session waiter's wakeup delivery against a real database.
 *
 * The unit suite stands a map in for the waiter row and an array for the event
 * log, and neither can show what two transactions racing one row do. Here the
 * claim is the real UPDATE and the wakeup the real event_log insert, so a
 * notify that arrives while another holds the claim open is turned away by
 * Postgres itself. Gated on DATABASE_URL like every pg test.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { TestContext } from 'vitest';

const mockAppendSessionEvent = vi.fn();
vi.mock('@aflow/redis', async () => ({
  ...(await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis')),
  // Mid-turn: the wakeup is appended to the hot stream and read at the turn's
  // boundary, so nothing here resumes the session.
  getSessionStateSafe: vi.fn().mockResolvedValue({ ok: true, state: { status: 'RUNNING' } }),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
}));

import { sql as drizzleSql } from 'drizzle-orm';
import { createDatabase, createTenantContext, withTenantSchema } from '@aflow/database';
import {
  addWaiter,
  claimSessionWaiterDelivery,
  loadParkedStepWaitersForSession,
  type SessionWaiterReport,
} from '@aflow/cybernetic-runtime';
import type { PayloadRef, TenantId } from '@aflow/schemas';
import { deliverSessionWakeup, runWakeupEventId } from '../sessionWakeup.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * The suite's namespace and this execution's own space inside it: the namespace
 * is what a later run sweeps an aborted one by, the random tail keeps two
 * concurrent runs out of each other's rows.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-5a4e-';
const SPACE_ID = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const RUN_PREFIX = 'session-wakeup-pg-';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('session waiter delivery (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID);
  const deps = { db, redis: {} as never, payloadStore: {} as never };

  let tenantPresent = false;
  let schemaReady = false;

  async function makeRun(): Promise<string> {
    const runId = `${RUN_PREFIX}${randomUUID()}`;
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO workflow_runs (space_id, workflow_slug, run_id, status, workflow_revision, started_at)
        VALUES (${SPACE_ID}::uuid, 'session-wakeup-test', ${runId}, 'running', 1, now())`),
    );
    return runId;
  }

  async function makeSession(): Promise<string> {
    const sessionId = randomUUID();
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO sessions (session_id, target_kind, target_system_role, agent_version,
                              status, started_at, last_activity_at, space_id)
        VALUES (${sessionId}::uuid, 'platform-role', 'cybernetic-helmsman', '1',
                'RUNNING', now(), now(), ${SPACE_ID}::uuid)`),
    );
    return sessionId;
  }

  /** A session that started a run without waiting on it, and its waiter row. */
  async function sessionWaitingOnRun(): Promise<{
    runId: string;
    sessionId: string;
    waiterId: string;
  }> {
    const runId = await makeRun();
    const sessionId = await makeSession();
    const waiterId = await addWaiter(db, TENANT_ID, { runId, waiterSessionId: sessionId });
    return { runId, sessionId, waiterId };
  }

  function deliver(
    waiter: { runId: string; sessionId: string; waiterId: string },
    report: SessionWaiterReport,
  ) {
    return deliverSessionWakeup(deps, {
      tenantId: TENANT_ID,
      sessionId: waiter.sessionId,
      runId: waiter.runId,
      waiterId: waiter.waiterId,
      report,
      storeEnvelope: () => Promise.resolve('gs://bucket/wakeup-envelope' as PayloadRef),
    });
  }

  async function loggedWakeups(sessionId: string): Promise<string[]> {
    const rows = await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute<{ event_id: string }>(drizzleSql`
        SELECT event_id FROM event_log
         WHERE session_id = ${sessionId}::uuid AND event_type = 'WorkflowRunWakeup'
         ORDER BY timestamp`),
    );
    return rows.map((row) => row.event_id);
  }

  async function waiterRow(waiterId: string) {
    const rows = await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute<{
        last_delivered_key: string | null;
        notified_at: Date | null;
        notified_outcome: string | null;
      }>(drizzleSql`
        SELECT last_delivered_key, notified_at, notified_outcome
          FROM workflow_run_waiters WHERE id = ${waiterId}::uuid`),
    );
    return rows[0];
  }

  async function sweep(where: 'aborted' | 'own'): Promise<void> {
    const spaces =
      where === 'own'
        ? drizzleSql`space_id = ${SPACE_ID}::uuid`
        : drizzleSql`space_id::text LIKE ${`${SPACE_NAMESPACE}%`} AND started_at < now() - interval '1 hour'`;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`
        DELETE FROM event_log WHERE session_id IN (SELECT session_id FROM sessions WHERE ${spaces})`);
      await tx.execute(drizzleSql`DELETE FROM sessions WHERE ${spaces}`);
      await tx.execute(drizzleSql`DELETE FROM workflow_runs WHERE ${spaces}`);
    });
  }

  beforeAll(async () => {
    const present = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
      ) AS ok`;
    tenantPresent = present[0]?.ok === true;
    if (!tenantPresent) return;
    const column = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = ${TENANT_SCHEMA}
           AND table_name = 'workflow_run_waiters'
           AND column_name = 'last_delivered_key'
      ) AS ok`;
    schemaReady = column[0]?.ok === true;
    if (schemaReady) await sweep('aborted');
  });

  // No tenant schema is CI, which seeds none; a tenant without the column is a
  // checkout that has not migrated, which is worth failing on.
  beforeEach((ctx: TestContext) => {
    mockAppendSessionEvent.mockClear();
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady) {
      throw new Error('workflow_run_waiters.last_delivered_key is missing — run yarn db:migrate');
    }
  });

  afterAll(async () => {
    if (schemaReady) await sweep('own');
    await handle.close();
  });

  it('two notifies of one pause racing each other write one wakeup', async () => {
    const waiter = await sessionWaitingOnRun();

    const results = await Promise.all([
      deliver(waiter, { outcome: 'paused', pauseVersion: 1 }),
      deliver(waiter, { outcome: 'paused', pauseVersion: 1 }),
    ]);

    expect(results.filter((result) => result.recorded)).toHaveLength(1);
    expect(await loggedWakeups(waiter.sessionId)).toEqual([
      runWakeupEventId(waiter.waiterId, 'paused:1'),
    ]);
    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(await waiterRow(waiter.waiterId)).toMatchObject({
      last_delivered_key: 'paused:1',
      notified_at: null,
    });
  });

  it('a notify arriving while another holds the claim open finds the pause delivered', async () => {
    const waiter = await sessionWaitingOnRun();
    let concurrent: ReturnType<typeof deliver> | undefined;

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await expect(
        claimSessionWaiterDelivery(tx, {
          waiterId: waiter.waiterId,
          report: { outcome: 'paused', pauseVersion: 1 },
        }),
      ).resolves.toBe(true);
      // Its UPDATE waits on this transaction's row lock, then re-reads the row
      // this transaction commits.
      concurrent = deliver(waiter, { outcome: 'paused', pauseVersion: 1 });
      await tx.execute(drizzleSql`SELECT pg_sleep(0.3)`);
    });

    await expect(concurrent).resolves.toMatchObject({ recorded: false });
    expect(await loggedWakeups(waiter.sessionId)).toEqual([]);
    expect(mockAppendSessionEvent).not.toHaveBeenCalled();
  });

  it('a later pause is a new wakeup, and a late notify of an earlier one appends nothing', async () => {
    const waiter = await sessionWaitingOnRun();

    await deliver(waiter, { outcome: 'paused', pauseVersion: 4 });
    await deliver(waiter, { outcome: 'paused', pauseVersion: 5 });
    const late = await deliver(waiter, { outcome: 'paused', pauseVersion: 4 });

    expect(late.recorded).toBe(false);
    expect(await loggedWakeups(waiter.sessionId)).toHaveLength(2);
    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
    expect(await waiterRow(waiter.waiterId)).toMatchObject({
      last_delivered_key: 'paused:5',
      notified_at: null,
    });
  });

  it('the run’s end retires the waiter in the commit that logs it', async () => {
    const waiter = await sessionWaitingOnRun();

    await expect(deliver(waiter, { outcome: 'completed' })).resolves.toMatchObject({
      recorded: true,
    });
    await expect(deliver(waiter, { outcome: 'paused', pauseVersion: 9 })).resolves.toMatchObject({
      recorded: false,
    });

    expect(await waiterRow(waiter.waiterId)).toMatchObject({
      last_delivered_key: 'completed',
      notified_at: expect.any(Date),
      notified_outcome: 'completed',
    });
    expect(await loggedWakeups(waiter.sessionId)).toEqual([
      runWakeupEventId(waiter.waiterId, 'completed'),
    ]);
  });

  it('counts only a parked step, not a run started without waiting, as a delegation wait', async () => {
    const sessionId = await makeSession();
    const startedRun = await makeRun();
    const parkedRun = await makeRun();
    await addWaiter(db, TENANT_ID, { runId: startedRun, waiterSessionId: sessionId });
    await addWaiter(db, TENANT_ID, {
      runId: parkedRun,
      waiterSessionId: sessionId,
      waiterStepExecutionId: randomUUID(),
    });

    const parked = await loadParkedStepWaitersForSession(db, TENANT_ID, sessionId);

    expect(parked.map((row) => row.runId)).toEqual([parkedRun]);
  });
});
