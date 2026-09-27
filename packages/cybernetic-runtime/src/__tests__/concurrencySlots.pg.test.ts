/**
 * Slot reservation against a real database.
 *
 * The unit tests prove the statements are shaped right and issued in order;
 * only Postgres can show that two schedulers racing the same run cannot each
 * observe the same free slots and dispatch against them twice. Gated on
 * DATABASE_URL like every pg test.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  type TenantContext,
} from '@aflow/database';
import { reserveTaskSlots, hasFreeSlotForTask } from '../ledger/concurrencySlots.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = randomUUID();

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('reserveTaskSlots — the limit is per-run, not per-scheduler (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);

  const runIds: string[] = [];
  let schemaReady = false;
  let tenantPresent = false;

  /** A run row pinned to `limit`, with no task rows yet. */
  async function makeRun(limit: number): Promise<string> {
    const runId = randomUUID();
    runIds.push(runId);
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO workflow_runs
          (space_id, workflow_slug, run_id, status, workflow_revision, started_at,
           effective_concurrency_policy)
        VALUES (${SPACE_ID}::uuid, 'slot-test', ${runId}, 'running', 1, now(),
                ${JSON.stringify({
                  maxParallelTasksPerRun: limit,
                  maxConcurrentRuns: 5,
                  failureMode: 'isolate',
                  perUserSerial: false,
                })}::jsonb)`),
    );
    return runId;
  }

  async function taskStatuses(runId: string): Promise<string[]> {
    const rows = await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute<{ task_id: string; status: string }>(
        drizzleSql`SELECT task_id, status FROM workflow_run_tasks WHERE run_id = ${runId} ORDER BY task_id`,
      ),
    );
    return rows.map((r) => `${r.task_id}:${r.status}`);
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'workflow_runs'
          AND column_name = 'effective_concurrency_policy'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    const present = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
      ) AS ok`;
    tenantPresent = present[0]?.ok === true;
  });

  // A tenant that was never created is CI, which seeds no dev schema and where a
  // database-backed suite has nothing to say. A tenant that exists without the
  // column is a checkout that has not migrated, which is worth failing on.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady)
      throw new Error(
        'workflow_runs.effective_concurrency_policy is missing — run yarn db:migrate',
      );
  });

  afterAll(async () => {
    if (schemaReady && runIds.length > 0) {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        for (const runId of runIds) {
          await tx.execute(drizzleSql`DELETE FROM workflow_run_tasks WHERE run_id = ${runId}`);
          await tx.execute(drizzleSql`DELETE FROM workflow_runs WHERE run_id = ${runId}`);
        }
      });
    }
    await handle.close();
  });

  it('has the pinned-policy column (migration 178 applied)', () => {
    expect(schemaReady).toBe(true);
  });

  // ⚠️ The ready lists MUST be disjoint. With the same list, the unique index on
  // (run_id, task_id) dedupes the two claims by itself and the test passes even
  // with the row lock removed — proving nothing. Disjoint lists are the only way
  // the count-then-claim race is observable: without the lock both schedulers
  // read the same free-slot count and each claims its own tasks against it.
  it('two schedulers claiming different tasks never exceed the limit between them', async () => {
    const runId = await makeRun(2);

    const [a, b] = await Promise.all([
      reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['a1', 'a2', 'a3'] }),
      reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['b1', 'b2', 'b3'] }),
    ]);

    const reserved = [...a.reserved, ...b.reserved];
    expect(reserved.length).toBeLessThanOrEqual(2);
    expect(await taskStatuses(runId)).toHaveLength(reserved.length);
  });

  it('four schedulers with disjoint work on a limit of one yield exactly one claim', async () => {
    const runId = await makeRun(1);

    const results = await Promise.all(
      ['w', 'x', 'y', 'z'].map((prefix) =>
        reserveTaskSlots(db, TENANT_ID, {
          runId,
          readyTaskIds: [`${prefix}1`, `${prefix}2`],
        }),
      ),
    );

    expect(results.flatMap((r) => r.reserved)).toHaveLength(1);
    expect(await taskStatuses(runId)).toHaveLength(1);
  });

  it('counts rows already holding a slot, so a second wave only takes what is left', async () => {
    const runId = await makeRun(3);
    const first = await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['x1', 'x2'] });
    expect(first.reserved).toHaveLength(2);

    const second = await reserveTaskSlots(db, TENANT_ID, {
      runId,
      readyTaskIds: ['x3', 'x4', 'x5'],
    });
    expect(second.reserved).toHaveLength(1);
    expect(second.activeCount).toBe(2);
    expect(second.deferred).toHaveLength(2);
  });

  it('frees the slot when a row reaches a terminal state', async () => {
    const runId = await makeRun(1);
    const first = await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['only'] });
    expect(first.reserved).toEqual(['only']);

    const blocked = await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['next'] });
    expect(blocked.reserved).toEqual([]);

    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(
        drizzleSql`UPDATE workflow_run_tasks SET status = 'succeeded' WHERE run_id = ${runId} AND task_id = 'only'`,
      ),
    );

    const after = await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['next'] });
    expect(after.reserved).toEqual(['next']);
  });

  // A polled task stays `running` between cycles. Releasing its slot there is
  // how four submissions become as many live provider jobs as the poll budget
  // allows.
  it('a task waiting between poll cycles keeps holding its slot', async () => {
    const runId = await makeRun(1);
    await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['poller'] });
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(
        drizzleSql`UPDATE workflow_run_tasks SET status = 'running', poll_cycle = 3 WHERE run_id = ${runId} AND task_id = 'poller'`,
      ),
    );

    const blocked = await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['other'] });
    expect(blocked.reserved).toEqual([]);
    expect(blocked.activeCount).toBe(1);
  });

  // A retry racing a dispatch wave is the lane that used to bypass the limit
  // entirely.
  it('a retry cannot take a slot the dispatch wave already filled', async () => {
    const runId = await makeRun(1);
    await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['dispatched'] });

    const room = await withTenantSchema(db, tenantCtx, (tx) =>
      hasFreeSlotForTask(tx, runId, 'retried'),
    );
    expect(room).toBe(false);
  });

  it('does not count the asking task against the budget it is asking for', async () => {
    const runId = await makeRun(1);
    await reserveTaskSlots(db, TENANT_ID, { runId, readyTaskIds: ['self'] });

    // Its own row is the only one holding a slot; excluding it is what lets a
    // row at limit-1 be re-driven instead of deadlocking against itself.
    const room = await withTenantSchema(db, tenantCtx, (tx) =>
      hasFreeSlotForTask(tx, runId, 'self'),
    );
    expect(room).toBe(true);
  });

  it('falls back to the schema default when the run predates the pinned policy', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO workflow_runs
          (space_id, workflow_slug, run_id, status, workflow_revision, started_at)
        VALUES (${SPACE_ID}::uuid, 'slot-test', ${runId}, 'running', 1, now())`),
    );

    const reservation = await reserveTaskSlots(db, TENANT_ID, {
      runId,
      readyTaskIds: ['n1', 'n2', 'n3', 'n4', 'n5'],
    });
    expect(reservation.limit).toBe(4);
    expect(reservation.reserved).toHaveLength(4);
  });

  it('fails loudly when the run row is missing rather than reporting no capacity', async () => {
    await expect(
      reserveTaskSlots(db, TENANT_ID, { runId: randomUUID(), readyTaskIds: ['ghost'] }),
    ).rejects.toThrow(/workflow run not found/);
  });
});
