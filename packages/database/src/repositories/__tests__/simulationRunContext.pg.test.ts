/**
 * The durable pin against a real database.
 *
 * Only Postgres can show that the second writer of a `(run, simulation)` pin
 * gets the first one's world back rather than its own — the property the whole
 * table exists for, and the one a unit test can only assert about a stand-in.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SimulationRunContext, TenantId } from '@aflow/schemas';
import { createDatabase } from '../../connection.js';
import { createTenantContext } from '../../tenant/context.js';
import { withTenantSchema } from '../../tenant/queries.js';
import { simulationRunContexts } from '../../schema/tenant/simulations.js';
import {
  pinDurableSimulationRunContext,
  readSimulationRunContext,
} from '../simulationRunContext.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = 'bb5a0000-0000-4000-8000-000000000002';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('simulation_run_contexts — the pin is written once (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID);

  const runId = randomUUID();
  let schemaReady = false;
  let tenantPresent = false;

  const context = (overrides: Partial<SimulationRunContext> = {}): SimulationRunContext => ({
    simulationId: 'bnpl-sim',
    simulationRevision: 4,
    baselineVersion: 2,
    snapshotRef: 'inline:eyJmaXJzdCI6dHJ1ZX0=',
    definitionHash: 'hash-first',
    seed: 'seed-first',
    clockAnchorMs: 1_700_000_000_000,
    ...overrides,
  });

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'simulation_run_contexts'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    const present = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
      ) AS ok`;
    tenantPresent = present[0]?.ok === true;
  });

  // A tenant that was never created is CI, which seeds no dev schema; a tenant
  // that exists without the table is a checkout that has not migrated.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} absent`);
      return;
    }
    expect(schemaReady, `run \`yarn db:migrate\` — ${TENANT_SCHEMA} has no pin table`).toBe(true);
  });

  afterAll(async () => {
    if (tenantPresent && schemaReady) {
      await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .delete(simulationRunContexts)
          .where(
            and(
              eq(simulationRunContexts.spaceId, SPACE_ID),
              eq(simulationRunContexts.runId, runId),
            ),
          ),
      );
    }
    await handle.close();
  });

  it('hands the second pin the world the first one claimed', async () => {
    const first = await pinDurableSimulationRunContext({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      runId,
      context: context(),
    });
    expect(first.baselineVersion).toBe(2);

    const second = await pinDurableSimulationRunContext({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      runId,
      context: context({
        baselineVersion: 9,
        snapshotRef: 'inline:eyJzZWNvbmQiOnRydWV9',
        seed: 'seed-second',
      }),
    });

    expect(second).toEqual(first);
    expect(
      await readSimulationRunContext({
        db,
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        runId,
        simulationId: 'bnpl-sim',
      }),
    ).toEqual(first);
  });

  it('answers null for a run that never pinned', async () => {
    expect(
      await readSimulationRunContext({
        db,
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        runId,
        simulationId: 'never-called-sim',
      }),
    ).toBeNull();
  });
});
