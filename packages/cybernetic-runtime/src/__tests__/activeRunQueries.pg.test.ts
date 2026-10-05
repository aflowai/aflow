/**
 * A run started on a plan node is read back with that node by the read the
 * attention block makes, against a real database. Gated on DATABASE_URL like
 * every pg test, and skipped where the tenant schema predates the column.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  tenantIdToSchemaName,
  withTenantSchema,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { listActiveRunsWithLiveness } from '../ledger/queries.js';
import { recordRunStart } from '../ledger/runs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = tenantIdToSchemaName(TENANT_ID);
const SPACE_ID = randomUUID();
const LIMIT = 10;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('listActiveRunsWithLiveness — a run carries its plan node (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  let columnPresent = false;

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'workflow_runs'
          AND column_name = 'plan_node_id'
      ) AS ok`;
    columnPresent = rows[0]?.ok === true;
  });

  beforeEach((test) => {
    if (!columnPresent) test.skip();
  });

  afterAll(async () => {
    if (columnPresent) {
      await withTenantSchema(handle.db, createTenantContext(TENANT_ID), (tx) =>
        tx.execute(drizzleSql`DELETE FROM workflow_runs WHERE space_id = ${SPACE_ID}::uuid`),
      );
    }
    await handle.close();
  });

  it('reads the node back on the run that serves it, and none on the run that serves none', async () => {
    const planNodeId = randomUUID();
    const onNode = `run-${randomUUID()}`;
    const offPlan = `run-${randomUUID()}`;
    const startedAt = new Date();
    for (const [runId, node] of [
      [onNode, planNodeId],
      [offPlan, undefined],
    ] as const) {
      await recordRunStart(handle.db, TENANT_ID, {
        spaceId: SPACE_ID,
        workflowSlug: 'plan-node-read-back',
        runId,
        workflowRevision: 1,
        startedAt,
        planNodeId: node,
      });
    }

    const runs = await listActiveRunsWithLiveness(handle.db, TENANT_ID, SPACE_ID, {
      limit: LIMIT,
    });

    expect(runs.find((run) => run.runId === onNode)).toMatchObject({ planNodeId });
    expect(runs.find((run) => run.runId === offPlan)).not.toHaveProperty('planNodeId');
  });
});
