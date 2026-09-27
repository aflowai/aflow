import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  createDatabase,
  withTenantSchema,
  createTenantContext,
  coachActivity,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { eq } from 'drizzle-orm';
import { recordCoachActivity } from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '234c1111-0000-0000-0000-000000000001';
const COACH_SESSION = '234c1111-0000-0000-0000-000000000002';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('recordCoachActivity (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(coachActivity).where(eq(coachActivity.spaceId, SPACE_ID));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'coach_activity'
          AND column_name = 'trigger_kind'
      ) = 1 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('inserts a row for the operator_requested_review finalize shape, idempotently', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    // Exact shape the review-finalize path builds for an operator-requested
    // review: bypassesGate true, no proposals, learnings recorded, doc paths set.
    const record = {
      spaceId: SPACE_ID,
      coachSessionId: COACH_SESSION,
      skillSlug: 'kaggle-competition-optimizer',
      triggerKind: 'operator_requested_review',
      triggerCause: 'manual retrigger',
      outcome: 'learning_only' as const,
      status: 'completed',
      proposalCount: 0,
      observationCount: 1,
      learningCount: 3,
      previewFailedCount: 0,
      bypassesGate: true,
      durationMs: 71_000,
      contextDocPath: `/coach/contexts/${COACH_SESSION}.json`,
      factsDocPath: `/coach/facts/${COACH_SESSION}.json`,
      rationale: 'Run is clean; promoted three run-level learnings to durable campaign scope.',
    };

    await recordCoachActivity({ tenantId: TENANT_ID, db }, record);

    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(coachActivity).where(eq(coachActivity.spaceId, SPACE_ID)),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.coachSessionId).toBe(COACH_SESSION);
    expect(row.skillSlug).toBe('kaggle-competition-optimizer');
    expect(row.triggerKind).toBe('operator_requested_review');
    expect(row.outcome).toBe('learning_only');
    expect(row.status).toBe('completed');
    expect(row.learningCount).toBe(3);
    expect(row.bypassesGate).toBe(true);
    expect(row.durationMs).toBe(71_000);

    // Same (spaceId, coachSessionId) again → conflict-do-nothing, no duplicate.
    await recordCoachActivity({ tenantId: TENANT_ID, db }, { ...record, learningCount: 99 });
    const after = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(coachActivity).where(eq(coachActivity.spaceId, SPACE_ID)),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.learningCount).toBe(3);
  });

  it('inserts a suppressed row without a coachSessionId (null session accumulates)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    await recordCoachActivity(
      { tenantId: TENANT_ID, db },
      {
        spaceId: SPACE_ID,
        skillSlug: 'kaggle-competition-optimizer',
        triggerKind: 'eval_signal',
        triggerCause: 'rate cap',
        outcome: 'suppressed',
        status: 'suppressed:rate_cap',
      },
    );

    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select().from(coachActivity).where(eq(coachActivity.spaceId, SPACE_ID)),
    );
    const suppressed = rows.filter((r) => r.coachSessionId === null);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.status).toBe('suppressed:rate_cap');
  });
});
