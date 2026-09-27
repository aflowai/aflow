/**
 * The standing guarantee behind the world-version allocator.
 *
 * The fold orders on `world_version_after`, so two records sharing a value
 * order arbitrarily and a run replays a world it never lived. Only Postgres can
 * show that the second writer is refused — the allocator's own reasoning about
 * high-waters is exactly the thing this index exists not to have to trust.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../../connection.js';
import { createTenantContext } from '../../tenant/context.js';
import { withTenantSchema } from '../../tenant/queries.js';
import {
  simulationCallRecords,
  type NewSimulationCallRecordRow,
} from '../../schema/tenant/simulations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = 'bb5a0000-0000-4000-8000-000000000002';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('simulation_call_records — one version per (run, simulation) (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID);

  const runId = randomUUID();
  let indexReady = false;
  let tenantPresent = false;

  const row = (overrides: Partial<NewSimulationCallRecordRow>): NewSimulationCallRecordRow => ({
    spaceId: SPACE_ID,
    runId,
    logicalExecutionId: `step:${randomUUID()}`,
    simulationId: 'bnpl-sim',
    bindingId: 'bind_bnpl',
    apiId: 'bnpl-core',
    endpointId: 'createRefund',
    requestJson: { method: 'POST', url: 'https://simulated.invalid/bnpl-core/refunds' },
    matchedJson: { rung: 'world' },
    responseStatus: 200,
    responseRef: 'inline:e30=',
    ordinal: 0,
    worldVersionBefore: 0,
    worldVersionAfter: 1,
    clockMs: 1_700_000_000_000,
    ...overrides,
  });

  const insert = async (values: NewSimulationCallRecordRow): Promise<void> => {
    await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.insert(simulationCallRecords).values(values),
    );
  };

  beforeAll(async () => {
    const present = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
      ) AS ok`;
    tenantPresent = present[0]?.ok === true;
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = ${TENANT_SCHEMA}
          AND indexname = 'uniq_simulation_call_records_world_version'
      ) AS ok`;
    indexReady = rows[0]?.ok === true;
  });

  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} absent`);
      return;
    }
    expect(
      indexReady,
      `run \`yarn db:migrate\` — ${TENANT_SCHEMA} has no world-version unique index`,
    ).toBe(true);
  });

  afterAll(async () => {
    if (tenantPresent && indexReady) {
      await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .delete(simulationCallRecords)
          .where(
            and(
              eq(simulationCallRecords.spaceId, SPACE_ID),
              eq(simulationCallRecords.runId, runId),
            ),
          ),
      );
    }
    await handle.close();
  });

  it('refuses a second record at a version the run already committed at', async () => {
    await insert(row({ worldVersionAfter: 1 }));

    // A different call — its own receipt, so nothing else in the key stops it.
    const refusal = await insert(row({ worldVersionAfter: 1, endpointId: 'getOrder' })).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).not.toBeNull();
    // Named from the driver error rather than the query wrapper around it:
    // the wrapper says only that the insert failed, and which constraint
    // refused is the whole assertion — the primary key would refuse a repeat
    // of one call, and that is a different guarantee.
    expect(String((refusal as { cause?: unknown }).cause)).toMatch(
      /uniq_simulation_call_records_world_version/,
    );
  });

  it('leaves a second simulation answering the same run free to use that version', async () => {
    await expect(
      insert(row({ worldVersionAfter: 1, simulationId: 'ledger-sim' })),
    ).resolves.toBeUndefined();
  });

  it('accepts the next version', async () => {
    await expect(insert(row({ worldVersionAfter: 2 }))).resolves.toBeUndefined();
  });
});
