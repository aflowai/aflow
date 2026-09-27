import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  createDatabase,
  withTenantSchema,
  createTenantContext,
  workflowRuns,
  campaigns,
  coachCandidateLearnings,
  coachLearnings,
} from '@aflow/database';
import type { TenantId, WorkflowLearning, WorkflowLearningKind } from '@aflow/schemas';
import { eq } from 'drizzle-orm';
import {
  ensureActiveCampaign,
  writeCandidateLearnings,
  listCandidatesByCampaign,
  listPendingCandidatesBySkill,
  resolveCandidateByNaturalKey,
  selectActiveLearningSet,
  resolveActiveSetBudget,
  insertCoachLearning,
  findCoachLearningByPromotedFromEntry,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '234f1111-0000-0000-0000-000000000001';
const OTHER_SPACE_ID = '234f1111-0000-0000-0000-000000000002';
const WORKFLOW_SLUG = 'natural-key-resolve-test-skill';
const GOAL_REF = `${WORKFLOW_SLUG}:numeric:lbValue:maximize`;
const RUN_ID = '234f2222-0000-0000-0000-000000000001';
const PROCESS_RUN_ID = '234f2222-0000-0000-0000-000000000002';

// Real-DB integration test (same gating as closingReplay.test.ts): runs only
// where the tenant schema is migrated; skips in the unit-test CI job.
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('resolveCandidateByNaturalKey (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;
  let campaignId = '';

  function learning(id: string, kind: WorkflowLearningKind, observation: string): WorkflowLearning {
    return {
      id,
      category: 'worked',
      kind,
      observation,
      recommendation: `act on ${id}`,
      evidence: { runId: '00000000-0000-0000-0000-000000000001' },
      confidence: 'medium',
      source: 'agent',
    };
  }

  const runLearnings = [
    learning('l-early', 'search_heuristic', 'resolved before the hook landed'),
    learning('l-late', 'search_heuristic', 'resolved after the hook landed'),
    learning('l-promote', 'next_direction', 'promoted before the hook landed'),
  ];

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .delete(coachCandidateLearnings)
        .where(eq(coachCandidateLearnings.skillSlug, WORKFLOW_SLUG));
      await tx.delete(coachLearnings).where(eq(coachLearnings.spaceId, SPACE_ID));
      await tx.delete(workflowRuns).where(eq(workflowRuns.workflowSlug, WORKFLOW_SLUG));
      await tx.delete(campaigns).where(eq(campaigns.workflowSlug, WORKFLOW_SLUG));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT (
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name IN ('coach_candidate_learnings', 'coach_learnings', 'workflow_runs')
      ) = 3 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(workflowRuns).where(eq(workflowRuns.workflowSlug, WORKFLOW_SLUG));
      await tx.delete(campaigns).where(eq(campaigns.workflowSlug, WORKFLOW_SLUG));
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('tombstones a pre-hook resolution, updates post-hook rows, and preserves the first resolution', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    const campaign = await ensureActiveCampaign(db, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: WORKFLOW_SLUG,
      goalRef: GOAL_REF,
      scoreMetricKey: 'lbValue',
      direction: 'maximize',
    });
    campaignId = campaign.campaignId;

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(workflowRuns).values({
        spaceId: SPACE_ID,
        workflowSlug: WORKFLOW_SLUG,
        runId: RUN_ID,
        status: 'completed',
        workflowRevision: 1,
        startedAt: new Date(),
        completedAt: new Date(),
        score: 0.78,
        campaignId,
        learningsJson: runLearnings,
      });
    });

    // ── The race: resolve BEFORE the hook has written any candidate row ──
    const early = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-early',
      status: 'reviewed-rejected',
      spaceId: SPACE_ID,
    });
    expect(early.applied).toBe(true);
    expect(early.entry).toMatchObject({
      campaignId,
      skillSlug: WORKFLOW_SLUG,
      learning: { id: 'l-early' },
      status: 'reviewed-rejected',
    });

    // The hook fires later — its onConflictDoNothing insert must preserve the
    // tombstone, never overwrite it back to pending.
    const written = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      runId: RUN_ID,
      learnings: runLearnings,
    });
    expect(written).toHaveLength(runLearnings.length);
    const earlyRow = written.find((c) => c.learning.id === 'l-early');
    expect(earlyRow?.status).toBe('reviewed-rejected');
    expect(earlyRow?.entryId).toBe(early.entry?.entryId);

    // And the tombstoned learning is never injected.
    const set = await selectActiveLearningSet({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      budget: resolveActiveSetBudget(null),
    });
    const injected = set.selected.flatMap((e) => (e.kind === 'candidate' ? [e.learningId] : []));
    expect(injected).not.toContain('l-early');
    expect(injected).toContain('l-late');

    // ── Post-hook resolve: updates the pending row in place ──────────────
    const late = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-late',
      status: 'reviewed-noise',
      spaceId: SPACE_ID,
    });
    expect(late.applied).toBe(true);
    expect(late.entry?.entryId).toBe(written.find((c) => c.learning.id === 'l-late')?.entryId);

    // ── First resolution wins: a second resolve is an idempotent no-op ───
    const again = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-early',
      status: 'reviewed-promoted',
      spaceId: SPACE_ID,
    });
    expect(again.applied).toBe(false);
    expect(again.entry?.entryId).toBe(early.entry?.entryId);
    expect(again.entry?.status).toBe('reviewed-rejected');

    const rows = await listCandidatesByCampaign(db, TENANT_ID, campaignId);
    expect(rows.filter((c) => c.learning.id === 'l-early')).toHaveLength(1);
    expect(rows.find((c) => c.learning.id === 'l-early')?.status).toBe('reviewed-rejected');
  });

  it('rejects a resolve from the wrong space and an unknown learning identity', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const wrongSpace = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-promote',
      status: 'reviewed-rejected',
      spaceId: OTHER_SPACE_ID,
    });
    expect(wrongSpace).toEqual({ applied: false });

    const unknown = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-does-not-exist',
      status: 'reviewed-rejected',
      spaceId: SPACE_ID,
    });
    expect(unknown).toEqual({ applied: false });

    // The wrong-space attempt must not have tombstoned the entry.
    const promote = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: RUN_ID,
      learningId: 'l-promote',
      status: 'reviewed-promoted',
      spaceId: SPACE_ID,
    });
    expect(promote.applied).toBe(true);
    expect(promote.entry?.learning.id).toBe('l-promote');
    expect(promote.entry?.status).toBe('reviewed-promoted');
  });

  it('finds the durable learning for a promoted candidate by its ledger entry id', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const entryId = '234f3333-0000-0000-0000-000000000001';
    const learningId = '234f3333-0000-0000-0000-000000000002';
    await insertCoachLearning(db, TENANT_ID, {
      spaceId: SPACE_ID,
      learning: {
        learningId,
        coachSessionId: '234f3333-0000-0000-0000-000000000003',
        runId: RUN_ID,
        scope: { kind: 'campaign', campaignId, skillSlug: WORKFLOW_SLUG },
        kind: 'heuristic',
        statement: 'promoted before the hook landed → act on l-promote',
        evidence: { citations: [{ runId: RUN_ID }] },
        confidence: 'medium',
        supersedes: [],
        authorityLevel: 'auto_record',
        status: 'auto_recorded',
        promotedFrom: { campaignId, candidateLedgerEntryId: entryId },
        createdAt: new Date().toISOString(),
      },
    });

    const found = await findCoachLearningByPromotedFromEntry(db, TENANT_ID, {
      spaceId: SPACE_ID,
      candidateLedgerEntryId: entryId,
    });
    expect(found?.learningId).toBe(learningId);
    expect(found?.promotedFrom).toEqual({ campaignId, candidateLedgerEntryId: entryId });

    const missing = await findCoachLearningByPromotedFromEntry(db, TENANT_ID, {
      spaceId: SPACE_ID,
      candidateLedgerEntryId: '234f3333-0000-0000-0000-000000000009',
    });
    expect(missing).toBeNull();

    const wrongSpace = await findCoachLearningByPromotedFromEntry(db, TENANT_ID, {
      spaceId: OTHER_SPACE_ID,
      candidateLedgerEntryId: entryId,
    });
    expect(wrongSpace).toBeNull();
  });

  it('process-run candidates: skill-keyed write, Coach-visible, never injected, resolvable pre-row', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const processLearnings = [
      learning('p-fact', 'observation', 'the repo pins node 22'),
      learning('p-early', 'observation', 'resolved before the hook landed'),
    ];
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(workflowRuns).values({
        spaceId: SPACE_ID,
        workflowSlug: WORKFLOW_SLUG,
        runId: PROCESS_RUN_ID,
        status: 'completed',
        workflowRevision: 1,
        startedAt: new Date(),
        completedAt: new Date(),
        learningsJson: processLearnings,
      });
    });

    // Tombstone works with no campaign link at all.
    const early = await resolveCandidateByNaturalKey(db, TENANT_ID, {
      runId: PROCESS_RUN_ID,
      learningId: 'p-early',
      status: 'reviewed-noise',
      spaceId: SPACE_ID,
    });
    expect(early.applied).toBe(true);
    expect(early.entry).toMatchObject({
      skillSlug: WORKFLOW_SLUG,
      learning: { id: 'p-early' },
      status: 'reviewed-noise',
    });
    expect(early.entry?.campaignId).toBeUndefined();

    const written = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      runId: PROCESS_RUN_ID,
      learnings: processLearnings,
    });
    expect(written).toHaveLength(processLearnings.length);
    expect(written.every((c) => c.campaignId === undefined)).toBe(true);
    expect(written.find((c) => c.learning.id === 'p-early')?.status).toBe('reviewed-noise');

    // A pending campaign-keyed candidate for the same skill must stay in the
    // campaign loop — never leak into the process review brief.
    await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      runId: RUN_ID,
      learnings: [learning('c-pending', 'search_heuristic', 'still awaiting the campaign review')],
    });

    // Visible to the Coach's skill-scoped review path…
    const pending = await listPendingCandidatesBySkill(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
    });
    expect(pending.map((c) => c.learning.id)).toContain('p-fact');
    expect(pending.map((c) => c.learning.id)).not.toContain('p-early');
    expect(pending.map((c) => c.learning.id)).not.toContain('c-pending');

    // …but never injected: process injection is durable-only.
    const set = await selectActiveLearningSet({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      budget: resolveActiveSetBudget(null),
    });
    expect(set.selected.some((e) => e.kind === 'candidate')).toBe(false);
  });
});
