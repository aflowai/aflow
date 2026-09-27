import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  createDatabase,
  withTenantSchema,
  createTenantContext,
  coachLearnings,
} from '@aflow/database';
import type { CoachLearning, TenantId } from '@aflow/schemas';
import { COACH_LEARNING_SUPERSEDES_MAX } from '@aflow/schemas';
import { eq } from 'drizzle-orm';
import {
  insertCoachLearning,
  getCoachLearningById,
  listDurableCoachLearnings,
  consolidateCoachLearnings,
  selectActiveLearningSet,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '234b1111-0000-0000-0000-000000000001';
const SLUG = 'consolidation-test-skill';
const COACH_SESSION = '234b1111-0000-0000-0000-000000000002';
const RUN_ID = '234b1111-0000-0000-0000-000000000003';

const SURVIVOR = '234b2222-0000-0000-0000-000000000001';
const DUP_A = '234b2222-0000-0000-0000-000000000002';
const DUP_B = '234b2222-0000-0000-0000-000000000003';
const INTERNAL = '234b2222-0000-0000-0000-000000000004';
const STALE = '234b2222-0000-0000-0000-000000000005';
const CONTRADICTED = '234b2222-0000-0000-0000-000000000006';
const NOISE = '234b2222-0000-0000-0000-000000000007';
const MERGE_SURV = '234b2222-0000-0000-0000-000000000008';
const MERGE_ABS = '234b2222-0000-0000-0000-000000000009';
const CAP_SURV = '234b2222-0000-0000-0000-00000000000a';
const CAP_ABS_A = '234b2222-0000-0000-0000-00000000000b';
const CAP_ABS_B = '234b2222-0000-0000-0000-00000000000c';
const UNKNOWN = '234b2222-0000-0000-0000-0000000000ff';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('consolidateCoachLearnings (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;

  function learning(learningId: string, statement: string): CoachLearning {
    return {
      learningId,
      coachSessionId: COACH_SESSION,
      scope: { kind: 'skill', skillSlug: SLUG },
      kind: 'heuristic',
      statement,
      evidence: { citations: [{ runId: RUN_ID }] },
      confidence: 'medium',
      supersedes: [],
      authorityLevel: 'auto_record',
      status: 'auto_recorded',
      createdAt: new Date().toISOString(),
    };
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(coachLearnings).where(eq(coachLearnings.spaceId, SPACE_ID));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'coach_learnings'
          AND column_name = 'resolution_note'
      ) = 1 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('applies merge / retire / disprove / prune and drops the resolved rows from every durable read', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    for (const [id, statement] of [
      [SURVIVOR, 'log-transform the target'],
      [DUP_A, 'log-transform helps (duplicate)'],
      [DUP_B, 'use log1p on the target (duplicate)'],
      [INTERNAL, 'always validate before submit'],
      [STALE, 'the leaderboard resets on Mondays'],
      [CONTRADICTED, 'shrinking the CV-LB gap improves the LB'],
      [NOISE, 'run 3 was slow'],
    ] as const) {
      await insertCoachLearning(db, TENANT_ID, {
        spaceId: SPACE_ID,
        learning: learning(id, statement),
      });
    }

    const results = await consolidateCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      resolvedBy: COACH_SESSION,
      actions: [
        { action: 'merge', survivorId: SURVIVOR, absorbedIds: [DUP_A, DUP_B] },
        { action: 'retire', learningId: INTERNAL, reason: 'internalized' },
        { action: 'retire', learningId: STALE, reason: 'stale' },
        {
          action: 'disprove',
          learningId: CONTRADICTED,
          rationale: 'LB regressed from peak while the gap shrank',
        },
        { action: 'prune', learningId: NOISE },
        { action: 'retire', learningId: UNKNOWN, reason: 'stale' },
      ],
    });

    expect(results).toEqual([
      { action: 'merge', learningIds: [SURVIVOR, DUP_A, DUP_B], ok: true },
      { action: 'retire', learningIds: [INTERNAL], ok: true },
      { action: 'retire', learningIds: [STALE], ok: true },
      { action: 'disprove', learningIds: [CONTRADICTED], ok: true },
      { action: 'prune', learningIds: [NOISE], ok: true },
      {
        action: 'retire',
        learningIds: [UNKNOWN],
        ok: false,
        error: `unknown learning id(s): ${UNKNOWN}`,
      },
    ]);

    const survivor = await getCoachLearningById(db, TENANT_ID, SPACE_ID, SURVIVOR);
    expect(survivor?.status).toBe('auto_recorded');
    expect(survivor?.supersedes).toEqual(expect.arrayContaining([DUP_A, DUP_B]));

    const dup = await getCoachLearningById(db, TENANT_ID, SPACE_ID, DUP_A);
    expect(dup?.status).toBe('superseded');
    expect(dup?.resolvedBy).toBe(COACH_SESSION);

    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, INTERNAL))?.status).toBe(
      'internalized',
    );
    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, STALE))?.status).toBe('retired');

    const disproven = await getCoachLearningById(db, TENANT_ID, SPACE_ID, CONTRADICTED);
    expect(disproven?.status).toBe('disproven');
    expect(disproven?.resolutionNote).toBe('LB regressed from peak while the gap shrank');

    expect(await getCoachLearningById(db, TENANT_ID, SPACE_ID, NOISE)).toBeNull();

    const durable = await listDurableCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      campaignScope: { mode: 'exclude' },
      limit: 50,
    });
    expect(durable.map((l) => l.learningId)).toEqual([SURVIVOR]);

    const set = await selectActiveLearningSet({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      budget: 20,
    });
    expect(set.selected).toEqual([
      expect.objectContaining({ kind: 'durable', learningId: SURVIVOR }),
    ]);
  });

  it('a merge citing any unknown id applies nothing for that action', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    await insertCoachLearning(db, TENANT_ID, {
      spaceId: SPACE_ID,
      learning: learning(MERGE_SURV, 'partial merge survivor'),
    });
    await insertCoachLearning(db, TENANT_ID, {
      spaceId: SPACE_ID,
      learning: learning(MERGE_ABS, 'partial merge absorbed'),
    });

    const results = await consolidateCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      resolvedBy: COACH_SESSION,
      actions: [{ action: 'merge', survivorId: MERGE_SURV, absorbedIds: [MERGE_ABS, UNKNOWN] }],
    });

    expect(results).toEqual([
      {
        action: 'merge',
        learningIds: [MERGE_SURV, MERGE_ABS, UNKNOWN],
        ok: false,
        error: `unknown learning id(s): ${UNKNOWN}`,
      },
    ]);
    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, MERGE_SURV))?.supersedes).toEqual(
      [],
    );
    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, MERGE_ABS))?.status).toBe(
      'auto_recorded',
    );
  });

  it('rejects a merge that would grow the survivor supersedes past the schema cap', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const existing = Array.from(
      { length: COACH_LEARNING_SUPERSEDES_MAX - 1 },
      (_, i) => `234b3333-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    );
    await insertCoachLearning(db, TENANT_ID, {
      spaceId: SPACE_ID,
      learning: { ...learning(CAP_SURV, 'near-cap survivor'), supersedes: existing },
    });
    for (const id of [CAP_ABS_A, CAP_ABS_B]) {
      await insertCoachLearning(db, TENANT_ID, {
        spaceId: SPACE_ID,
        learning: learning(id, 'absorbed past the cap'),
      });
    }

    const results = await consolidateCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      resolvedBy: COACH_SESSION,
      actions: [{ action: 'merge', survivorId: CAP_SURV, absorbedIds: [CAP_ABS_A, CAP_ABS_B] }],
    });

    expect(results[0]).toMatchObject({
      action: 'merge',
      ok: false,
      error: expect.stringContaining(`max ${String(COACH_LEARNING_SUPERSEDES_MAX)}`),
    });
    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, CAP_SURV))?.supersedes).toEqual(
      existing,
    );
    expect((await getCoachLearningById(db, TENANT_ID, SPACE_ID, CAP_ABS_A))?.status).toBe(
      'auto_recorded',
    );
  });

  it('rejects a merge whose survivor appears in absorbedIds', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const results = await consolidateCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      resolvedBy: COACH_SESSION,
      actions: [{ action: 'merge', survivorId: MERGE_SURV, absorbedIds: [MERGE_SURV] }],
    });
    expect(results[0]).toMatchObject({
      ok: false,
      error: 'survivorId must not appear in absorbedIds',
    });
  });
});
