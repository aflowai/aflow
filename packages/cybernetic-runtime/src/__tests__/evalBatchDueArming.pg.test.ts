/**
 * Every write that makes eval-batch work claimable must arm the due pointer.
 *
 * The engine reads only the pointer, so a write that arms nothing makes its own
 * batch invisible: it hangs `queued` forever, its trials are never dispatched or
 * graded, and nothing anywhere reports a problem. The reverse failure is just as
 * quiet — a pointer nobody lowers keeps a tenant claimed every cycle for work
 * that finished.
 *
 * The coverage is per-writer and deliberately includes writers that are not
 * TypeScript at all: a raw INSERT and a raw terminal status flip. Those are the
 * cases a shared write primitive could not have covered, and they are why the
 * arming is a row trigger.
 *
 * Real Postgres, on a schema cloned from the live tenant one: the arming is DDL,
 * the claim is `FOR UPDATE SKIP LOCKED`, and neither has a fake. The clone keeps
 * the tenant's own pointer row out of the assertions.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import {
  createDatabase,
  tenantIdToSchemaName,
  evalBatchDueTriggerDdl,
  evalBatchDueSeedDdl,
  EVAL_BATCH_DUE_SOURCES,
  EVAL_BATCH_DUE_TABLE,
  EVAL_BATCH_DUE_TRIGGER,
  claimDueEvalBatchTenants,
  settleEvalBatchTenantDue,
  releaseEvalBatchTenantClaim,
  clearEvalBatchDueForTenant,
} from '@aflow/database';
import type { EvalBatchProvenanceManifest, TenantId } from '@aflow/schemas';
import { casEvalBatchStatus, createEvalBatch } from '../evalBatchStore.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const SOURCE_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SOURCE_SCHEMA = tenantIdToSchemaName(SOURCE_TENANT);
const TENANT = 'd1d10000-0000-4000-8000-000000000902' as TenantId;
const SCHEMA = tenantIdToSchemaName(TENANT);
const CLONED_TABLES = ['eval_batches', 'eval_batch_members', 'eval_case_results', 'spaces'];

const SPACE = '55ed0000-0000-4000-8000-0000000009f2';
const MANIFEST = {} as EvalBatchProvenanceManifest;

interface PointerRow {
  due_ms: string;
  armed_seq: string;
  leased: boolean;
  claimed_by: string | null;
}

let handle: { db: PostgresJsDatabase; sql: postgres.Sql } | undefined;

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass(${EVAL_BATCH_DUE_TABLE}) IS NOT NULL
         AND to_regclass(${`${SOURCE_SCHEMA}.eval_batches`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

describe.skipIf(!READY)('eval-batch due pointer arming', () => {
  const db = (): PostgresJsDatabase => handle!.db;
  const sql = (): postgres.Sql => handle!.sql;

  async function pointer(): Promise<PointerRow | null> {
    const rows = await sql().unsafe<PointerRow[]>(
      `SELECT (extract(epoch FROM due_at) * 1000)::bigint::text AS due_ms,
              armed_seq::text AS armed_seq,
              (lease_until IS NOT NULL) AS leased,
              claimed_by
         FROM ${EVAL_BATCH_DUE_TABLE} WHERE tenant_id = $1::uuid`,
      [TENANT],
    );
    return rows[0] ?? null;
  }

  async function dueAtMs(): Promise<number | null> {
    const row = await pointer();
    return row ? Number(row.due_ms) : null;
  }

  async function batchCreatedAtMs(batchId: string): Promise<number> {
    const rows = await sql().unsafe<Array<{ ms: string }>>(
      `SELECT (extract(epoch FROM created_at) * 1000)::bigint::text AS ms
         FROM "${SCHEMA}".eval_batches WHERE id = $1::uuid`,
      [batchId],
    );
    return Number(rows[0]!.ms);
  }

  /** The ordinary launch path: one queued batch with its frozen trial rows. */
  async function launchBatch(): Promise<string> {
    const { batchId } = await createEvalBatch(db(), TENANT, {
      spaceId: SPACE,
      workflowSlug: 'daily-metrics',
      datasetId: randomUUID(),
      datasetVersion: 1,
      workflowRevision: 2,
      trialsPerCase: 1,
      maxConcurrentTrials: 2,
      costCeilingCents: 500,
      validationSliceSize: 0,
      provenanceManifest: MANIFEST,
      caseRevisionIds: [randomUUID()],
    });
    return batchId;
  }

  /** A batch row written the way a non-TypeScript path writes it: raw SQL. */
  async function insertBatch(status: string): Promise<void> {
    await sql().unsafe(
      `INSERT INTO "${SCHEMA}".eval_batches
         (space_id, workflow_slug, dataset_id, dataset_version, workflow_revision, status,
          trials_per_case, max_concurrent_trials, cost_ceiling_cents, provenance_manifest_json)
       VALUES ($1::uuid, 'raw-write', gen_random_uuid(), 1, 1, $2, 1, 1, 100, '{}'::jsonb)`,
      [SPACE, status],
    );
  }

  async function insertFixtureSpace(expiresAt: Date | null): Promise<void> {
    await sql().unsafe(
      `INSERT INTO "${SCHEMA}".spaces (name, slug, expires_at)
       VALUES ('fixture', $1, $2::timestamptz)`,
      [`eval-fx-${randomUUID().slice(0, 8)}`, expiresAt?.toISOString() ?? null],
    );
  }

  async function claimOne(token: string): Promise<{ tenantId: string; armedSeq: string }[]> {
    return claimDueEvalBatchTenants(sql(), { limit: 10, leaseMs: 60_000, claimToken: token });
  }

  beforeAll(async () => {
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    for (const table of CLONED_TABLES) {
      await sql().unsafe(
        `CREATE TABLE "${SCHEMA}".${table} (LIKE "${SOURCE_SCHEMA}".${table} INCLUDING ALL)`,
      );
    }
    await sql().unsafe(evalBatchDueTriggerDdl(SCHEMA));
  });

  afterAll(async () => {
    if (!handle) return;
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await clearEvalBatchDueForTenant(sql(), TENANT);
    await handle.sql.end();
  });

  beforeEach(async () => {
    for (const table of CLONED_TABLES) {
      await sql().unsafe(`TRUNCATE "${SCHEMA}".${table} CASCADE`);
    }
    await clearEvalBatchDueForTenant(sql(), TENANT);
  });

  describe('trigger installation', () => {
    async function installedTrigger(
      schemaName: string,
      table: string,
    ): Promise<{ tgtype: number; cols: string[] | null } | undefined> {
      const rows = await sql()<Array<{ tgtype: number; cols: string[] | null }>>`
        SELECT t.tgtype,
               (SELECT array_agg(a.attname ORDER BY a.attname)
                  FROM unnest(t.tgattr) AS x(attnum)
                  JOIN pg_attribute a
                    ON a.attrelid = t.tgrelid AND a.attnum = x.attnum) AS cols
          FROM pg_trigger t
         WHERE t.tgrelid = ${`"${schemaName}".${table}`}::regclass
           AND t.tgname = ${EVAL_BATCH_DUE_TRIGGER}`;
      return rows[0];
    }

    it.each(EVAL_BATCH_DUE_SOURCES.map((source) => [source.table, source] as const))(
      'arms %s on insert and on every column that can change its due time',
      async (table, source) => {
        const trigger = await installedTrigger(SCHEMA, table);
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

    it.each(EVAL_BATCH_DUE_SOURCES.map((source) => [source.table, source] as const))(
      'has already installed %s on a migrated tenant schema',
      async (table, source) => {
        // The clone above is built from the current DDL, so it can never fail.
        // A migrated schema can: a source added to the list reaches an existing
        // tenant only through a migration, and adding one is the step that gets
        // forgotten.
        const trigger = await installedTrigger(SOURCE_SCHEMA, table);
        expect(
          trigger,
          `${table} carries a declared due source but no migration has installed its trigger on ${SOURCE_SCHEMA}.`,
        ).toBeDefined();
        expect(trigger!.cols?.slice().sort()).toEqual([...source.writtenBy].sort());
      },
    );
  });

  describe('writers', () => {
    it('arms on the launch path — a queued batch is due immediately', async () => {
      const batchId = await launchBatch();
      expect(await dueAtMs()).toBe(await batchCreatedAtMs(batchId));
    });

    it('arms on a batch row written in raw SQL', async () => {
      await insertBatch('running');
      expect(await pointer()).not.toBeNull();
    });

    it('leaves a batch that is already terminal alone', async () => {
      await insertBatch('completed');
      expect(await pointer()).toBeNull();
    });

    it('re-arms on the status transition into cancelling', async () => {
      const batchId = await launchBatch();
      const armedBefore = (await pointer())!.armed_seq;

      await casEvalBatchStatus(db(), TENANT, {
        batchId,
        from: ['queued', 'running'],
        to: 'cancelling',
      });

      // A cancelling batch still owes the engine a drain, so the arm counts —
      // and the due time stays where the batch has been waiting since launch.
      expect(Number((await pointer())!.armed_seq)).toBeGreaterThan(Number(armedBefore));
      expect(await dueAtMs()).toBe(await batchCreatedAtMs(batchId));
    });

    it('arms on a fixture space expiry, with no batch anywhere', async () => {
      // Fixture spaces outlive the batch that made them, so their collection is
      // its own reason to nominate a tenant.
      const expiresAt = new Date(Date.now() + 60_000);
      await insertFixtureSpace(expiresAt);
      expect(await dueAtMs()).toBe(expiresAt.getTime());
    });

    it('leaves an ordinary space alone', async () => {
      await insertFixtureSpace(null);
      expect(await pointer()).toBeNull();
    });
  });

  describe('claim and settle', () => {
    it('never claims a tenant with no eval work', async () => {
      await insertBatch('completed');
      await insertFixtureSpace(null);
      await sql().unsafe(evalBatchDueSeedDdl(SCHEMA));

      expect(await pointer()).toBeNull();
      expect(await claimOne(randomUUID())).toEqual([]);
    });

    it('leases a claimed tenant away from the next claim', async () => {
      await launchBatch();
      expect(await claimOne(randomUUID())).toHaveLength(1);
      expect(await claimOne(randomUUID())).toEqual([]);
    });

    it('keeps the pointer while the batch is still live', async () => {
      const batchId = await launchBatch();
      const token = randomUUID();
      const [claim] = await claimOne(token);

      const settlement = await settleEvalBatchTenantDue(sql(), claim!, token);

      expect(settlement).toEqual({ drained: false, rearmed: false });
      const row = await pointer();
      expect(row?.leased).toBe(false);
      expect(Number(row?.due_ms)).toBe(await batchCreatedAtMs(batchId));
    });

    it('drops the pointer once the last batch reaches a terminal status', async () => {
      await launchBatch();
      const token = randomUUID();
      const [claim] = await claimOne(token);
      // The terminal write is raw on purpose: nothing about dropping the
      // pointer depends on which writer terminalized the batch.
      await sql().unsafe(`UPDATE "${SCHEMA}".eval_batches SET status = 'completed'`);

      expect(await settleEvalBatchTenantDue(sql(), claim!, token)).toEqual({
        drained: true,
        rearmed: false,
      });
      expect(await pointer()).toBeNull();
    });

    it('keeps a tenant whose batches are done but whose fixture space is not', async () => {
      await launchBatch();
      const expiresAt = new Date(Date.now() + 3_600_000);
      await insertFixtureSpace(expiresAt);
      const token = randomUUID();
      const [claim] = await claimOne(token);
      await sql().unsafe(`UPDATE "${SCHEMA}".eval_batches SET status = 'completed'`);

      const settlement = await settleEvalBatchTenantDue(sql(), claim!, token);

      expect(settlement.drained).toBe(false);
      expect(await dueAtMs()).toBe(expiresAt.getTime());
    });

    it('discards a settle whose tenant was re-armed mid-cycle', async () => {
      await launchBatch();
      const token = randomUUID();
      const [claim] = await claimOne(token);
      await sql().unsafe(`UPDATE "${SCHEMA}".eval_batches SET status = 'completed'`);
      // A batch launched after the claim: the recompute this settle is about to
      // run could not have seen it, so the settle must not act on its snapshot.
      await launchBatch();

      expect(await settleEvalBatchTenantDue(sql(), claim!, token)).toEqual({
        drained: false,
        rearmed: true,
      });
      const row = await pointer();
      expect(row).not.toBeNull();
      expect(row?.leased).toBe(false);
    });

    it('hands a released claim straight back to the next cycle', async () => {
      await launchBatch();
      const token = randomUUID();
      const [claim] = await claimOne(token);

      await releaseEvalBatchTenantClaim(sql(), claim!.tenantId, token);

      expect(await claimOne(randomUUID())).toHaveLength(1);
    });
  });

  describe('migration-time arming', () => {
    it('arms a tenant whose batch predates the triggers', async () => {
      // A queued or running batch is written again only by the engine, and that
      // write is the work the pointer exists to cause — so everything in flight
      // when the triggers arrive is invisible to them forever.
      const batchId = await launchBatch();
      await clearEvalBatchDueForTenant(sql(), TENANT);
      expect(await pointer()).toBeNull();

      await sql().unsafe(evalBatchDueSeedDdl(SCHEMA));

      expect(await dueAtMs()).toBe(await batchCreatedAtMs(batchId));
    });

    it('arms a fixture space whose expiry predates the triggers', async () => {
      const expiresAt = new Date(Date.now() - 30_000);
      await insertFixtureSpace(expiresAt);
      await clearEvalBatchDueForTenant(sql(), TENANT);

      await sql().unsafe(evalBatchDueSeedDdl(SCHEMA));

      expect(await dueAtMs()).toBe(expiresAt.getTime());
    });
  });
});
