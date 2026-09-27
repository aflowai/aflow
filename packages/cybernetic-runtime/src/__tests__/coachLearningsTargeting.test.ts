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
import { eq } from 'drizzle-orm';
import {
  insertCoachLearning,
  listDurableCoachLearnings,
  countDurableCoachLearnings,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '234b3111-0000-0000-0000-000000000001';
const SLUG = 'targeting-test-skill';
const COACH_SESSION = '234b3111-0000-0000-0000-000000000002';
const RUN_ID = '234b3111-0000-0000-0000-000000000003';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('durable coach learnings task targeting (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;

  function learning(
    learningId: string,
    statement: string,
    createdAt: string,
    appliesTo?: CoachLearning['appliesTo'],
  ): CoachLearning {
    return {
      learningId,
      coachSessionId: COACH_SESSION,
      scope: { kind: 'skill', skillSlug: SLUG },
      kind: 'heuristic',
      ...(appliesTo !== undefined ? { appliesTo } : {}),
      statement,
      evidence: { citations: [{ runId: RUN_ID }] },
      confidence: 'medium',
      supersedes: [],
      authorityLevel: 'auto_record',
      status: 'auto_recorded',
      createdAt,
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
          AND column_name = 'applies_to'
      ) = 1 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('applies the taskId predicate before limit and count — rows targeted elsewhere never fill the window', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    const rows: CoachLearning[] = [
      learning('234b3222-0000-0000-0000-000000000001', 'other 1', '2026-06-08T09:00:00.000Z', {
        kind: 'tasks',
        taskIds: ['other-task'],
      }),
      learning('234b3222-0000-0000-0000-000000000002', 'other 2', '2026-06-08T08:00:00.000Z', {
        kind: 'tasks',
        taskIds: ['other-task', 'third-task'],
      }),
      learning('234b3222-0000-0000-0000-000000000003', 'other 3', '2026-06-08T07:00:00.000Z', {
        kind: 'tasks',
        taskIds: ['other-task'],
      }),
      learning('234b3222-0000-0000-0000-000000000004', 'skill-wide', '2026-06-08T06:00:00.000Z', {
        kind: 'skill',
      }),
      learning('234b3222-0000-0000-0000-000000000005', 'untargeted', '2026-06-08T05:00:00.000Z'),
      learning('234b3222-0000-0000-0000-000000000006', 'mine', '2026-06-08T04:00:00.000Z', {
        kind: 'tasks',
        taskIds: ['my-task'],
      }),
    ];
    for (const l of rows) {
      await insertCoachLearning(db, TENANT_ID, { spaceId: SPACE_ID, learning: l });
    }

    const filter = {
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      campaignScope: { mode: 'exclude' } as const,
    };

    const windowed = await listDurableCoachLearnings(db, TENANT_ID, {
      ...filter,
      taskId: 'my-task',
      limit: 3,
    });
    expect(windowed.map((l) => l.statement)).toEqual(['skill-wide', 'untargeted', 'mine']);

    expect(await countDurableCoachLearnings(db, TENANT_ID, { ...filter, taskId: 'my-task' })).toBe(
      3,
    );
    expect(
      await countDurableCoachLearnings(db, TENANT_ID, { ...filter, taskId: 'third-task' }),
    ).toBe(3);
    expect(await countDurableCoachLearnings(db, TENANT_ID, filter)).toBe(6);

    const unfiltered = await listDurableCoachLearnings(db, TENANT_ID, { ...filter, limit: 10 });
    expect(unfiltered).toHaveLength(6);
  });
});
