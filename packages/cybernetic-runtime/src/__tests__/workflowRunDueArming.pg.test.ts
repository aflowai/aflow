/**
 * Every write that makes a workflow run reconcilable must arm the due pointer.
 *
 * The reconciler reads only the pointer, so a write that arms nothing makes its
 * own run invisible: the task hangs `running` in Postgres, its waiters never
 * wake, and nothing anywhere reports a problem. Five ledger functions write a
 * completion-pending due time, around twenty statements put a run back into
 * `running`, and two cascade paths delete rows in hand-written SQL — a suite
 * that arms through one convenient helper cannot catch the one that skips,
 * because the helper is never the writer that skips.
 *
 * So the coverage is per-writer, and it deliberately includes two writers that
 * are not TypeScript at all: a raw INSERT and a raw status flip. Those are the
 * cases a shared write primitive could not have covered, and they are why the
 * arming is a row trigger.
 *
 * Real Postgres, on a schema cloned from the live tenant one: the arming is
 * DDL, the claim is `FOR UPDATE SKIP LOCKED`, and neither has a fake. The
 * clone keeps the tenant's own pointer row out of the assertions.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  createDatabase,
  tenantIdToSchemaName,
  workflowRunDueTriggerDdl,
  workflowRunDueTriggerNameFor,
  workflowRunDueSeedDdl,
  WORKFLOW_RUN_DUE_SOURCES,
  claimDueWorkflowRunTenants,
  settleWorkflowRunTenantDue,
  releaseWorkflowRunTenantClaim,
  clearWorkflowRunDueForTenant,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { claimAndSchedule } from '../ledger/claims.js';
import { addCompletionPending, bumpCompletionPendingDueAt } from '../ledger/waiters.js';
import { advanceTaskPollCycle } from '../ledger/tasks.js';
import { claimRetriedTask } from '../ledger/retry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const SOURCE_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SOURCE_SCHEMA = tenantIdToSchemaName(SOURCE_TENANT);
const TENANT = 'd1d10000-0000-4000-8000-000000000901' as TenantId;
const SCHEMA = tenantIdToSchemaName(TENANT);
const CLONED_TABLES = [
  'workflow_runs',
  'workflow_run_tasks',
  'workflow_run_completion_pending',
  // The envelope source's recompute reads the run's space to tell a run the
  // post-run hook owes an envelope from one it deliberately skips.
  'spaces',
];

const RUN = 'run-due-arming';
const SPACE = '55ed0000-0000-4000-8000-0000000009f1';

interface PointerRow {
  due_ms: string;
  armed_seq: string;
  leased: boolean;
  claimed_by: string | null;
}

type Claim = Awaited<ReturnType<typeof claimDueWorkflowRunTenants>>[number];

let handle: { db: PostgresJsDatabase; sql: postgres.Sql } | undefined;

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass('public.workflow_run_due') IS NOT NULL
         AND to_regclass(${`${SOURCE_SCHEMA}.workflow_runs`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

describe.skipIf(!READY)('workflow-run due pointer arming', () => {
  const db = (): PostgresJsDatabase => handle!.db;
  const sql = (): postgres.Sql => handle!.sql;

  async function pointer(): Promise<PointerRow | null> {
    const rows = await sql()<PointerRow[]>`
      SELECT (extract(epoch FROM due_at) * 1000)::bigint::text AS due_ms,
             armed_seq::text AS armed_seq,
             (lease_until IS NOT NULL) AS leased,
             claimed_by
        FROM public.workflow_run_due WHERE tenant_id = ${TENANT}`;
    return rows[0] ?? null;
  }

  async function dueAtMs(): Promise<number | null> {
    const row = await pointer();
    return row ? Number(row.due_ms) : null;
  }

  /**
   * Claim, keeping only this tenant's claim. The claim's row order is not its due
   * order, and any tenant of this database can legitimately be due — so a test
   * that took the first claim would assert against someone else's, and one that
   * walked away would leave that tenant leased for the rest of the suite.
   */
  async function claimDue(claimToken: string): Promise<Claim[]> {
    const claimed = await claimDueWorkflowRunTenants(sql(), {
      limit: 50,
      leaseMs: 60_000,
      claimToken,
    });
    for (const other of claimed) {
      if (other.tenantId !== TENANT) {
        await releaseWorkflowRunTenantClaim(sql(), other.tenantId, claimToken);
      }
    }
    return claimed.filter((c) => c.tenantId === TENANT);
  }

  /** A run row written the way every non-ledger path writes it: raw SQL. */
  async function insertRun(deadline: Date | null, status = 'running'): Promise<void> {
    await sql().unsafe(
      `INSERT INTO "${SCHEMA}".workflow_runs
         (space_id, workflow_slug, run_id, status, workflow_revision, started_at, scheduler_cursor_deadline)
       VALUES ($1::uuid, 'due-arming', $2, $3, 1, now(), $4::timestamptz)`,
      [SPACE, RUN, status, deadline?.toISOString() ?? null],
    );
  }

  /** The run's space, cybernetic or not — only the former is owed an envelope. */
  async function insertSpace(cybernetic: boolean): Promise<void> {
    await sql().unsafe(
      `INSERT INTO "${SCHEMA}".spaces (id, name, slug, directives)
       VALUES ($1::uuid, 'due-arming', 'due-arming', $2::jsonb)`,
      [SPACE, cybernetic ? JSON.stringify({ mission: 'due-arming' }) : null],
    );
  }

  async function terminalize(completedAt: Date | null, status = 'completed'): Promise<void> {
    await sql().unsafe(
      `UPDATE "${SCHEMA}".workflow_runs
          SET status = $1, completed_at = $2::timestamptz`,
      [status, completedAt?.toISOString() ?? null],
    );
  }

  async function insertTaskRow(taskId: string, workerSessionId: string | null): Promise<void> {
    await sql().unsafe(
      `INSERT INTO "${SCHEMA}".workflow_run_tasks
         (run_id, task_id, status, attempt, worker_session_id, started_at, poll_cycle)
       VALUES ($1, $2, 'running', 1, $3::uuid, now(), 1)`,
      [RUN, taskId, workerSessionId],
    );
  }

  beforeAll(async () => {
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    for (const table of CLONED_TABLES) {
      await sql().unsafe(
        `CREATE TABLE "${SCHEMA}".${table} (LIKE "${SOURCE_SCHEMA}".${table} INCLUDING ALL)`,
      );
    }
    // `LIKE` never copies foreign keys, and the cascade from a deleted run is
    // one of the delete paths under test.
    await sql().unsafe(`
      ALTER TABLE "${SCHEMA}".workflow_run_completion_pending
        ADD CONSTRAINT pending_run_fk FOREIGN KEY (run_id)
        REFERENCES "${SCHEMA}".workflow_runs(run_id) ON DELETE CASCADE`);
    await sql().unsafe(workflowRunDueTriggerDdl(SCHEMA));
  });

  afterAll(async () => {
    if (!handle) return;
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await clearWorkflowRunDueForTenant(sql(), TENANT);
    await handle.sql.end();
  });

  beforeEach(async () => {
    for (const table of CLONED_TABLES) {
      await sql().unsafe(`TRUNCATE "${SCHEMA}".${table} CASCADE`);
    }
    await clearWorkflowRunDueForTenant(sql(), TENANT);
  });

  describe('trigger installation', () => {
    async function installedTrigger(
      schemaName: string,
      table: string,
      triggerName: string,
    ): Promise<{ tgtype: number; cols: string[] | null } | undefined> {
      const rows = await sql()<Array<{ tgtype: number; cols: string[] | null }>>`
        SELECT t.tgtype,
               (SELECT array_agg(a.attname ORDER BY a.attname)
                  FROM unnest(t.tgattr) AS x(attnum)
                  JOIN pg_attribute a
                    ON a.attrelid = t.tgrelid AND a.attnum = x.attnum) AS cols
          FROM pg_trigger t
         WHERE t.tgrelid = ${`"${schemaName}".${table}`}::regclass
           AND t.tgname = ${triggerName}`;
      return rows[0];
    }

    it.each(WORKFLOW_RUN_DUE_SOURCES.map((source) => [source.table, source] as const))(
      'arms %s on insert and on every column that can change its due time',
      async (table, source) => {
        const trigger = await installedTrigger(SCHEMA, table, workflowRunDueTriggerNameFor(source));
        expect(
          trigger,
          `${table} has no arming trigger — a write to it arms nothing`,
        ).toBeDefined();
        // TRIGGER_TYPE_ROW = 1, _INSERT = 4, _UPDATE = 16.
        expect(trigger!.tgtype & 1).toBe(1);
        expect(trigger!.tgtype & 4).toBe(4);
        expect(trigger!.tgtype & 16).toBe(16);
        expect(trigger!.cols?.slice().sort()).toEqual([...source.writtenBy].sort());
      },
    );

    it.each(WORKFLOW_RUN_DUE_SOURCES.map((source) => [source.table, source] as const))(
      'has already installed %s on a migrated tenant schema',
      async (table, source) => {
        // The clone above is built from the current DDL, so it can never fail.
        // A migrated schema can: a source added to the list reaches an existing
        // tenant only through a migration, and adding one is the step that gets
        // forgotten.
        const trigger = await installedTrigger(
          SOURCE_SCHEMA,
          table,
          workflowRunDueTriggerNameFor(source),
        );
        expect(
          trigger,
          `${table} carries a declared due source but no migration has installed its trigger on ${SOURCE_SCHEMA}.`,
        ).toBeDefined();
        expect(trigger!.cols?.slice().sort()).toEqual([...source.writtenBy].sort());
      },
    );
  });

  describe('writers', () => {
    it('arms on a run row written in raw SQL', async () => {
      const deadline = new Date(Date.now() + 60_000);
      await insertRun(deadline);
      expect(await dueAtMs()).toBe(deadline.getTime());
    });

    it('leaves a run that is not running alone', async () => {
      await insertRun(new Date(Date.now() + 60_000), 'paused');
      expect(await pointer()).toBeNull();
    });

    it('arms on claimAndSchedule — the ordinary dispatch path', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const dueAt = new Date(Date.now() + 30_000);
      const claimed = await claimAndSchedule(db(), TENANT, {
        runId: RUN,
        taskId: 'claim-schedule',
        attempt: 1,
        workerSessionId: randomUUID(),
        dispatchAttemptToken: randomUUID(),
        inputRef: 'inline:x',
        dueAt,
      });
      expect(claimed).toBe(true);
      expect(await dueAtMs()).toBe(dueAt.getTime());
    });

    it('arms on addCompletionPending — the orphan-redispatch path', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const dueAt = new Date(Date.now() + 20_000);
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'add-pending',
        attempt: 1,
        workerSessionId: randomUUID(),
        dueAt,
      });
      expect(await dueAtMs()).toBe(dueAt.getTime());
    });

    it('arms on advanceTaskPollCycle, which moves an existing due time', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const worker = randomUUID();
      await insertTaskRow('poll', worker);
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'poll',
        attempt: 1,
        workerSessionId: worker,
        dueAt: new Date(Date.now() + 500_000),
      });

      const dueAt = new Date(Date.now() + 15_000);
      const advanced = await advanceTaskPollCycle(db(), TENANT, {
        runId: RUN,
        taskId: 'poll',
        attempt: 1,
        fromCycle: 1,
        toCycle: 2,
        stepExecutionId: randomUUID(),
        dueAt,
      });
      expect(advanced).toBe(true);
      expect(await dueAtMs()).toBe(dueAt.getTime());
    });

    it('arms on claimRetriedTask', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      await insertTaskRow('retried', null);
      const dueAt = new Date(Date.now() + 25_000);
      const claimed = await claimRetriedTask(db(), TENANT, {
        runId: RUN,
        taskId: 'retried',
        attempt: 1,
        workerSessionId: randomUUID(),
        dispatchAttemptToken: randomUUID(),
        inputRef: 'inline:x',
        dueAt,
      });
      expect(claimed).toBe(true);
      expect(await dueAtMs()).toBe(dueAt.getTime());
    });

    it('arms on bumpCompletionPendingDueAt — the sweeper re-arming itself', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const worker = randomUUID();
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'bumped',
        attempt: 1,
        workerSessionId: worker,
        dueAt: new Date(Date.now() + 500_000),
      });

      const newDueAt = new Date(Date.now() + 5_000);
      const bumped = await bumpCompletionPendingDueAt(db(), TENANT, {
        runId: RUN,
        taskId: 'bumped',
        attempt: 1,
        newDueAt,
      });
      expect(bumped).toBe(true);
      expect(await dueAtMs()).toBe(newDueAt.getTime());
    });

    it('arms on a paused run put back to running without touching its deadline', async () => {
      // The resume commits write `status` and leave `scheduler_cursor_deadline`
      // exactly as the pause left it — long expired. There are eight of them and
      // not one would have called an arming helper, because the column they need
      // to arm on is not the column they write.
      const expired = new Date(Date.now() - 600_000);
      await insertRun(expired, 'paused');
      expect(await pointer()).toBeNull();

      await sql().unsafe(`UPDATE "${SCHEMA}".workflow_runs SET status = 'running'`);
      expect(await dueAtMs()).toBe(expired.getTime());
    });

    it('arms on a completion-pending row inserted with no TypeScript involved', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const dueAt = new Date(Date.now() + 1_000);
      await sql().unsafe(
        `INSERT INTO "${SCHEMA}".workflow_run_completion_pending
           (run_id, task_id, attempt, worker_session_id, due_at)
         VALUES ($1, 'raw', 1, gen_random_uuid(), $2::timestamptz)`,
        [RUN, dueAt.toISOString()],
      );
      expect(await dueAtMs()).toBe(dueAt.getTime());
    });

    it('never moves the pointer later than the earliest work', async () => {
      const early = new Date(Date.now() + 10_000);
      await insertRun(early);
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'late',
        attempt: 1,
        workerSessionId: randomUUID(),
        dueAt: new Date(Date.now() + 900_000),
      });
      expect(await dueAtMs()).toBe(early.getTime());
    });

    it('arms on the terminal write, which is the last thing a crashed run gets', async () => {
      // The post-run hook writes the envelope in-process; a worker that dies in
      // between leaves a run nothing else revisits, so the terminal write itself
      // has to nominate the tenant.
      await insertSpace(true);
      await insertRun(null);
      expect(await pointer()).toBeNull();

      const completedAt = new Date(Date.now() - 1000);
      await terminalize(completedAt);
      expect(await dueAtMs()).toBe(completedAt.getTime());
    });

    it('leaves a terminal run with no completion time alone', async () => {
      // The pointer's due time is NOT NULL, so a run that went terminal without
      // one must not arm at all — it would fail the tenant's own write.
      await insertSpace(true);
      await insertRun(null);
      await terminalize(null, 'cancelled');
      expect(await pointer()).toBeNull();
    });

    it('rolls back with the tenant write that armed it', async () => {
      // The arming rides the caller's transaction, so a claim that fails after
      // inserting its row leaves no pointer behind either.
      await sql()
        .begin(async (tx) => {
          await tx.unsafe(
            `INSERT INTO "${SCHEMA}".workflow_runs
               (space_id, workflow_slug, run_id, status, workflow_revision, started_at, scheduler_cursor_deadline)
             VALUES ($1::uuid, 'due-arming', $2, 'running', 1, now(), now())`,
            [SPACE, RUN],
          );
          const inTx = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM public.workflow_run_due WHERE tenant_id = ${TENANT}`;
          expect(inTx[0]?.n).toBe(1);
          throw new Error('rollback');
        })
        .catch(() => undefined);

      expect(await pointer()).toBeNull();
    });
  });

  describe('claim and settle', () => {
    it('claims a due tenant once and leases it away from the next claimant', async () => {
      await insertRun(new Date(Date.now() - 1000));
      const token = randomUUID();
      const claimed = await claimDue(token);
      expect(claimed.map((c) => c.tenantId)).toContain(TENANT);

      const second = await claimDue(randomUUID());
      expect(second.map((c) => c.tenantId)).not.toContain(TENANT);
    });

    it('does not claim a tenant whose work is still in the future', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      const claimed = await claimDue(randomUUID());
      expect(claimed.map((c) => c.tenantId)).not.toContain(TENANT);
    });

    it('settles the pointer forward to the tenant’s next real due time', async () => {
      await insertRun(new Date(Date.now() - 1000));
      const next = new Date(Date.now() + 300_000);
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'next',
        attempt: 1,
        workerSessionId: randomUUID(),
        dueAt: next,
      });
      // The reconciler's own re-stamp: the run is alive, so its deadline moves.
      await sql().unsafe(
        `UPDATE "${SCHEMA}".workflow_runs SET scheduler_cursor_deadline = $1::timestamptz`,
        [new Date(Date.now() + 600_000).toISOString()],
      );

      const token = randomUUID();
      const [claim] = await claimDue(token);
      const settled = await settleWorkflowRunTenantDue(sql(), claim!, token);

      expect(settled).toEqual({ drained: false, rearmed: false });
      expect(await dueAtMs()).toBe(next.getTime());
      const row = await pointer();
      expect(row?.leased).toBe(false);
      expect(row?.claimed_by).toBeNull();
    });

    it('drops the pointer when the tenant has no reconcilable work left', async () => {
      await insertRun(new Date(Date.now() - 1000));
      const token = randomUUID();
      const [claim] = await claimDue(token);

      // What the reconciler does when it finishes a run: the row goes terminal
      // and its completion-pending bookkeeping goes with it.
      await sql().unsafe(`UPDATE "${SCHEMA}".workflow_runs SET status = 'completed'`);

      expect(await settleWorkflowRunTenantDue(sql(), claim!, token)).toEqual({
        drained: true,
        rearmed: false,
      });
      expect(await pointer()).toBeNull();
    });

    it('keeps a terminal run due until its envelope is written', async () => {
      await insertSpace(true);
      await insertRun(null);
      const completedAt = new Date(Date.now() - 1000);
      await terminalize(completedAt);

      const token = randomUUID();
      const [claim] = await claimDue(token);
      expect(await settleWorkflowRunTenantDue(sql(), claim!, token)).toEqual({
        drained: false,
        rearmed: false,
      });
      expect(await dueAtMs()).toBe(completedAt.getTime());

      await sql().unsafe(
        `UPDATE "${SCHEMA}".workflow_runs SET evaluation_json = '{"decision":"no_suite"}'::jsonb`,
      );
      const second = randomUUID();
      const [reclaim] = await claimDue(second);
      expect(await settleWorkflowRunTenantDue(sql(), reclaim!, second)).toEqual({
        drained: true,
        rearmed: false,
      });
      expect(await pointer()).toBeNull();
    });

    it('drains a terminal run whose space is not cybernetic', async () => {
      // The trigger cannot reach the space row, so it arms broader than the
      // recompute. That direction is safe — one wasted claim — but only because
      // the recompute drops the pointer instead of keeping the tenant due for
      // work the post-run hook deliberately skips.
      await insertSpace(false);
      await insertRun(null);
      await terminalize(new Date(Date.now() - 1000));
      expect(await pointer()).not.toBeNull();

      const token = randomUUID();
      const [claim] = await claimDue(token);
      expect(await settleWorkflowRunTenantDue(sql(), claim!, token)).toEqual({
        drained: true,
        rearmed: false,
      });
      expect(await pointer()).toBeNull();
    });

    it('refuses to settle past work armed during the cycle', async () => {
      await insertRun(new Date(Date.now() - 1000));
      const token = randomUUID();
      const [claim] = await claimDue(token);

      // Committed after the claim: a settle that recomputed without seeing it
      // would push the pointer past work that is already due.
      const urgent = new Date(Date.now() - 5000);
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'urgent',
        attempt: 1,
        workerSessionId: randomUUID(),
        dueAt: urgent,
      });
      await sql().unsafe(
        `UPDATE "${SCHEMA}".workflow_runs SET scheduler_cursor_deadline = $1::timestamptz`,
        [new Date(Date.now() + 600_000).toISOString()],
      );

      expect(await settleWorkflowRunTenantDue(sql(), claim!, token)).toEqual({
        drained: false,
        rearmed: true,
      });
      expect(await dueAtMs()).toBe(urgent.getTime());
      expect((await pointer())?.claimed_by).toBeNull();
    });

    it('hands a claim back untouched when the cycle runs out of budget', async () => {
      await insertRun(new Date(Date.now() - 1000));
      const token = randomUUID();
      const [claim] = await claimDue(token);
      await releaseWorkflowRunTenantClaim(sql(), claim!.tenantId, token);

      const reclaimed = await claimDue(randomUUID());
      expect(reclaimed.map((c) => c.tenantId)).toContain(TENANT);
    });
  });

  describe('deletes', () => {
    it('needs no disarming — the cascade leaves an over-armed pointer the settle repairs', async () => {
      await insertRun(new Date(Date.now() + 600_000));
      await addCompletionPending(db(), TENANT, {
        runId: RUN,
        taskId: 'cascaded',
        attempt: 1,
        workerSessionId: randomUUID(),
        dueAt: new Date(Date.now() - 1000),
      });

      // No application code runs for this: the FK on the completion-pending row
      // takes it with the run, exactly as the space and session cascades do.
      await sql().unsafe(`DELETE FROM "${SCHEMA}".workflow_runs`);
      expect(await pointer()).not.toBeNull();

      const token = randomUUID();
      const [claim] = await claimDue(token);
      await settleWorkflowRunTenantDue(sql(), claim!, token);
      expect(await pointer()).toBeNull();
    });
  });

  describe('migration-time arming', () => {
    it('arms a tenant whose work predates the triggers', async () => {
      // Everything outstanding when the triggers are installed is invisible to
      // them, and most of it — a completion-pending row whose worker died, a run
      // left running past its deadline — is never written again.
      const deadline = new Date(Date.now() - 30_000);
      await insertRun(deadline);
      await clearWorkflowRunDueForTenant(sql(), TENANT);
      expect(await pointer()).toBeNull();

      await sql().unsafe(workflowRunDueSeedDdl(SCHEMA));
      expect(await dueAtMs()).toBe(deadline.getTime());
    });

    it('arms a tenant whose terminal runs predate the envelope writer', async () => {
      // A run that is already terminal is written again only by the repair
      // itself, so the seed is the only thing that can nominate the history a
      // tenant carries into the migration.
      await insertSpace(true);
      await insertRun(null);
      const completedAt = new Date(Date.now() - 900_000);
      await terminalize(completedAt);
      await clearWorkflowRunDueForTenant(sql(), TENANT);
      expect(await pointer()).toBeNull();

      await sql().unsafe(workflowRunDueSeedDdl(SCHEMA));
      expect(await dueAtMs()).toBe(completedAt.getTime());
    });
  });
});
