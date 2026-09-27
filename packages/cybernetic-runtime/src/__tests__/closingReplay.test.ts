import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import type { Redis } from 'ioredis';
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
import type {
  CoachLearning,
  TenantId,
  WorkflowLearning,
  WorkflowLearningKind,
} from '@aflow/schemas';
import { eq, inArray } from 'drizzle-orm';
import {
  ensureActiveCampaign,
  getCampaignScoreSeries,
  writeCandidateLearnings,
  listCandidatesByCampaign,
  resolveCandidate,
  selectActiveLearningSet,
  resolveActiveSetBudget,
  shouldActivateCoach,
  bestScoreByDirection,
  insertCoachLearning,
  getCoachLearningById,
  listDurableCoachLearnings,
  listCoachLearningsForSkill,
  updateCoachLearningResolution,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '183f1111-0000-0000-0000-000000000001';
const OTHER_SPACE_ID = '183f1111-0000-0000-0000-000000000002';
const WORKFLOW_SLUG = 'closing-replay-test-skill';
const GOAL_REF = `${WORKFLOW_SLUG}:numeric:lbValue:maximize`;

// Real-DB integration test. Runs only where the tenant schema is migrated
// (local dev, or a CI integration job that runs `db:migrate`). When the schema
// isn't provisioned (the unit-test CI job, which mocks pg), the suite SKIPS at
// runtime — the loop mechanics are covered deterministically in any environment
// by promotion.test.ts + candidateInjection.test.ts.
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 183 §8.1 — closing replay (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  // shouldActivateCoach only touches redis on the `sampled` branch (not hit here).
  const redisStub = {} as unknown as Redis;

  let schemaReady = false;
  let campaignId = '';
  let started = Date.UTC(2026, 5, 7, 0, 0, 0);

  function learning(kind: WorkflowLearningKind, observation: string): WorkflowLearning {
    return {
      id: `l-${kind}-${String(started)}`,
      category: 'worked',
      kind,
      observation,
      evidence: { runId: '00000000-0000-0000-0000-000000000001' },
      confidence: 'medium',
      source: 'agent',
    };
  }

  async function seedRun(
    runId: string,
    score: number,
    learnings?: WorkflowLearning[],
  ): Promise<void> {
    started += 60_000;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(workflowRuns).values({
        spaceId: SPACE_ID,
        workflowSlug: WORKFLOW_SLUG,
        runId,
        status: 'completed',
        workflowRevision: 1,
        startedAt: new Date(started),
        completedAt: new Date(started + 1000),
        score,
        campaignId,
        ...(learnings ? { learningsJson: learnings } : {}),
      });
    });
  }

  async function injectedCandidateObservations(): Promise<string[]> {
    const set = await selectActiveLearningSet({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      budget: resolveActiveSetBudget(null),
    });
    return set.selected.flatMap((e) => (e.kind === 'candidate' ? [e.observation] : []));
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    // Readiness gate: only run when the tenant schema's tables exist. The
    // information_schema query is always safe (no dependency on the tenant
    // tables themselves), so this never throws on an un-provisioned DB.
    const rows = await sql<{ ok: boolean }[]>`
      SELECT (
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name IN ('coach_candidate_learnings', 'coach_learnings')
      ) = 2 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    // Clean any leftovers from a prior run.
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(workflowRuns).where(eq(workflowRuns.workflowSlug, WORKFLOW_SLUG));
      await tx.delete(campaigns).where(eq(campaigns.workflowSlug, WORKFLOW_SLUG));
      await tx
        .delete(coachLearnings)
        .where(inArray(coachLearnings.spaceId, [SPACE_ID, OTHER_SPACE_ID]));
    });
  });

  afterAll(async () => {
    if (schemaReady) {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        if (campaignId) {
          await tx
            .delete(coachCandidateLearnings)
            .where(eq(coachCandidateLearnings.campaignId, campaignId));
        }
        await tx.delete(workflowRuns).where(eq(workflowRuns.workflowSlug, WORKFLOW_SLUG));
        await tx.delete(campaigns).where(eq(campaigns.workflowSlug, WORKFLOW_SLUG));
        await tx
          .delete(coachLearnings)
          .where(inArray(coachLearnings.spaceId, [SPACE_ID, OTHER_SPACE_ID]));
      });
    }
    await handle.close();
  });

  it('closes the loop: seed peak → inject heuristic → regress → trajectory_signal → reject → recover', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }
    // 1. Campaign identity (materialized from the numeric goal).
    const campaign = await ensureActiveCampaign(db, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: WORKFLOW_SLUG,
      goalRef: GOAL_REF,
      scoreMetricKey: 'lbValue',
      direction: 'maximize',
    });
    campaignId = campaign.campaignId;
    expect(campaign.direction).toBe('maximize');

    // 2. Seed a low-noise baseline near the peak. The σ-band detector needs
    //    ≥ minRuns (default 6) scored runs and a baseline to estimate noise
    //    from — so a few runs establish the level + its natural variation.
    const baseline = [0.785, 0.787, 0.786, 0.788, 0.787]; // peak 0.788, small noise
    // The peak run records its learnings durably in `learnings_json` DURING
    // the run — candidate materialization is an async post-terminal hook.
    const peakLearnings = [
      learning('search_heuristic', 'shrink the CV-LB gap by adding L2 regularization'),
      learning('eval_semantics', 'reinterpret lbValue as normalized'),
    ];
    for (let i = 0; i < baseline.length; i++) {
      await seedRun(
        `replay-baseline-${i + 1}`,
        baseline[i]!,
        i === baseline.length - 1 ? peakLearnings : undefined,
      );
    }
    const peakRunId = 'replay-baseline-5';

    // 3a. BEFORE the hook writes candidate rows, the selector's read-through
    //     union already injects the fast-inject learning (§0.2: run N records →
    //     run N+1 started immediately still injects it); the blocked kind stays out.
    const injectedPreHook = await injectedCandidateObservations();
    expect(injectedPreHook).toContain('shrink the CV-LB gap by adding L2 regularization');
    expect(injectedPreHook).not.toContain('reinterpret lbValue as normalized');

    // 3b. The hook lands (same learning identities) — no duplicate injection.
    const written = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      runId: peakRunId,
      learnings: peakLearnings,
    });
    const heuristicEntry = written.find((c) => c.learning.kind === 'search_heuristic');
    expect(heuristicEntry).toBeDefined();

    // Idempotent per run — a re-completed run re-enters finalize and must NOT
    const rewritten = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId,
      runId: peakRunId,
      learnings: [
        { ...peakLearnings[0]!, observation: 'a different observation on re-completion' },
      ],
    });
    expect(rewritten.map((c) => c.entryId).sort()).toEqual(written.map((c) => c.entryId).sort());
    const allForPeakRun = (await listCandidatesByCampaign(db, TENANT_ID, campaignId)).filter(
      (c) => c.runId === peakRunId,
    );
    expect(allForPeakRun).toHaveLength(written.length); // no duplicates

    // The heuristic is injected (fast-inject) exactly once — the candidate row
    // and the read-through dedup on the (runId, learningId) identity; the
    // eval_semantics one is blocked.
    const injectedBefore = await injectedCandidateObservations();
    expect(
      injectedBefore.filter((o) => o === 'shrink the CV-LB gap by adding L2 regularization'),
    ).toHaveLength(1);
    expect(injectedBefore).not.toContain('reinterpret lbValue as normalized');

    // 4. A SUSTAINED slide from the peak (the over-regularization drift) — each
    //    run still beats the ~0.70 "baseline", but the campaign is regressing
    //    several σ below its established level.
    const drift = [0.78, 0.779, 0.781];
    for (let i = 0; i < drift.length; i++) {
      await seedRun(`replay-drift-${i + 1}`, drift[i]!);
    }
    const seriesAfterRegress = await getCampaignScoreSeries(db, TENANT_ID, campaignId);
    expect(seriesAfterRegress.map((p) => p.score)).toEqual([...baseline, ...drift]);

    // 5. The trajectory-regression producer fires (eval passes, past bootstrap).
    //    Default σ-band knobs (k=2, minRuns=6, recentWindow=3) — the recent
    //    window's mean is ~6σ below the baseline peak.
    const gate = await shouldActivateCoach({
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: WORKFLOW_SLUG,
      runId: 'replay-drift-3',
      totalRuns: 12, // past the default bootstrap window of 5
      evalResult: { verdict: 'pass', scores: { overall: 0.92 }, regressionDetected: false },
      trajectory: {
        direction: 'maximize',
        series: seriesAfterRegress.map((p) => p.score),
      },
      db,
      redis: redisStub,
    });
    expect(gate?.source).toBe('trajectory_signal');

    // 5b. A monotonically-improving series of the same length must NOT fire —
    //     the recent window is a NEW high, not a drop from the baseline peak.
    const noRegress = await shouldActivateCoach({
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: WORKFLOW_SLUG,
      runId: 'replay-drift-3',
      totalRuns: 12,
      evalResult: { verdict: 'pass', scores: { overall: 0.92 }, regressionDetected: false },
      trajectory: {
        direction: 'maximize',
        series: [0.78, 0.785, 0.79, 0.795, 0.8, 0.805, 0.81, 0.815],
      },
      db,
      redis: redisStub,
    });
    expect(noRegress).toBeNull();

    // 6. The resolve is space-scoped — a different space cannot resolve this
    //    tenant's candidate even with the entryId (PR #409 review).
    const wrongSpace = await resolveCandidate(db, TENANT_ID, {
      entryId: heuristicEntry!.entryId,
      status: 'reviewed-rejected',
      spaceId: '183f1111-0000-0000-0000-0000000000ff',
    });
    expect(wrongSpace).toBe(false);

    // The boundary review rejects the bad heuristic (correct space).
    const resolved = await resolveCandidate(db, TENANT_ID, {
      entryId: heuristicEntry!.entryId,
      status: 'reviewed-rejected',
      spaceId: SPACE_ID,
    });
    expect(resolved).toBe(true);

    // 7. It stops being injected (no longer pending) — and the resolved row's
    //    identity keeps suppressing the read-through re-entry from the run's
    //    still-present learnings_json.
    const injectedAfter = await injectedCandidateObservations();
    expect(injectedAfter).not.toContain('shrink the CV-LB gap by adding L2 regularization');
    // It survives as negative evidence.
    const rejected = await listCandidatesByCampaign(db, TENANT_ID, campaignId, {
      status: 'reviewed-rejected',
    });
    expect(rejected).toHaveLength(1);

    // 8. The next run recovers; recovery is visible in the series.
    await seedRun('replay-recovery-1', 0.79);
    const finalSeries = await getCampaignScoreSeries(db, TENANT_ID, campaignId);
    expect(finalSeries.map((p) => p.score)).toEqual([...baseline, ...drift, 0.79]);
    const best = bestScoreByDirection(
      finalSeries.map((p) => p.score),
      'maximize',
    );
    expect(best).toBe(0.79); // recovery beat the prior peak (0.788)
    const last = finalSeries[finalSeries.length - 1]!.score;
    const prev = finalSeries[finalSeries.length - 2]!.score;
    expect(last).toBeGreaterThan(prev); // recovered from the regression
  });

  it('durable store: scope admission, status filter, round-trip, resolution', async (ctx: TestContext) => {
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
    const otherCampaign = await ensureActiveCampaign(db, TENANT_ID, {
      spaceId: SPACE_ID,
      workflowSlug: WORKFLOW_SLUG,
      goalRef: `${WORKFLOW_SLUG}:numeric:cvValue:maximize`,
      scoreMetricKey: 'cvValue',
      direction: 'maximize',
    });

    const at = (i: number): string => new Date(Date.UTC(2026, 5, 8, 0, i)).toISOString();
    function coachLearning(params: {
      statement: string;
      scope: CoachLearning['scope'];
      status?: CoachLearning['status'];
      createdAt: string;
    }): CoachLearning {
      const status = params.status ?? 'auto_recorded';
      return {
        learningId: randomUUID(),
        coachSessionId: '00000000-0000-0000-0000-0000000000c0',
        scope: params.scope,
        kind: 'heuristic',
        statement: params.statement,
        evidence: { citations: [{ runId: '00000000-0000-0000-0000-000000000001' }] },
        confidence: 'high',
        supersedes: [],
        authorityLevel: status === 'auto_recorded' ? 'auto_record' : 'stage_for_review',
        status,
        createdAt: params.createdAt,
      };
    }

    const spaceFact = coachLearning({
      statement: 'space-scope fact',
      scope: { kind: 'space', spaceId: SPACE_ID },
      createdAt: at(1),
    });
    const skillRatified = coachLearning({
      statement: 'skill-scope ratified fact',
      scope: { kind: 'skill', skillSlug: WORKFLOW_SLUG },
      status: 'ratified',
      createdAt: at(2),
    });
    const skillProposed = coachLearning({
      statement: 'proposed skill fact',
      scope: { kind: 'skill', skillSlug: WORKFLOW_SLUG },
      status: 'proposed',
      createdAt: at(3),
    });
    const skillRejected = coachLearning({
      statement: 'rejected skill fact',
      scope: { kind: 'skill', skillSlug: WORKFLOW_SLUG },
      status: 'rejected',
      createdAt: at(4),
    });
    const otherSkillFact = coachLearning({
      statement: 'other-skill fact',
      scope: { kind: 'skill', skillSlug: 'closing-replay-other-skill' },
      createdAt: at(5),
    });
    const thisCampaignFact = coachLearning({
      statement: 'this-campaign fact',
      scope: { kind: 'campaign', campaignId: campaign.campaignId, skillSlug: WORKFLOW_SLUG },
      createdAt: at(6),
    });
    const otherCampaignFact = coachLearning({
      statement: 'other-campaign fact',
      scope: { kind: 'campaign', campaignId: otherCampaign.campaignId, skillSlug: WORKFLOW_SLUG },
      createdAt: at(7),
    });
    for (const learning of [
      spaceFact,
      skillRatified,
      skillProposed,
      skillRejected,
      otherSkillFact,
      thisCampaignFact,
      otherCampaignFact,
    ]) {
      await insertCoachLearning(db, TENANT_ID, { spaceId: SPACE_ID, learning });
    }
    const otherSpaceFact = coachLearning({
      statement: 'other-space fact',
      scope: { kind: 'space', spaceId: OTHER_SPACE_ID },
      createdAt: at(8),
    });
    await insertCoachLearning(db, TENANT_ID, { spaceId: OTHER_SPACE_ID, learning: otherSpaceFact });

    // Insert flattening (campaign_id / skill_slug columns) reconstructs losslessly.
    expect(
      await getCoachLearningById(db, TENANT_ID, SPACE_ID, thisCampaignFact.learningId),
    ).toEqual(thisCampaignFact);

    // Runner injection: space + skill + this-campaign scopes, durable statuses only.
    const set = await selectActiveLearningSet({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignId: campaign.campaignId,
      budget: 20,
    });
    const durableStatements = set.selected.flatMap((e) =>
      e.kind === 'durable' ? [e.statement] : [],
    );
    expect([...durableStatements].sort()).toEqual([
      'skill-scope ratified fact',
      'space-scope fact',
      'this-campaign fact',
    ]);

    // Coach brief: any campaign of the skill admitted, newest first.
    const brief = await listDurableCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignScope: { mode: 'skill-campaigns' },
      limit: 50,
    });
    expect(brief.map((l) => l.statement)).toEqual([
      'other-campaign fact',
      'this-campaign fact',
      'skill-scope ratified fact',
      'space-scope fact',
    ]);

    // Operator panel: any status, campaign + skill scopes; space-scope excluded.
    const panel = await listCoachLearningsForSkill(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      limit: 50,
    });
    expect(panel.map((l) => l.statement).sort()).toEqual([
      'other-campaign fact',
      'proposed skill fact',
      'rejected skill fact',
      'skill-scope ratified fact',
      'this-campaign fact',
    ]);

    // Resolution is space-scoped; ratifying moves the learning into the durable tier.
    expect(
      await updateCoachLearningResolution(db, TENANT_ID, {
        spaceId: OTHER_SPACE_ID,
        learningId: skillProposed.learningId,
        status: 'ratified',
        resolvedBy: 'operator:test',
      }),
    ).toBe(false);
    expect(
      await updateCoachLearningResolution(db, TENANT_ID, {
        spaceId: SPACE_ID,
        learningId: skillProposed.learningId,
        status: 'ratified',
        resolvedBy: 'operator:test',
      }),
    ).toBe(true);
    const afterRatify = await listDurableCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: WORKFLOW_SLUG,
      campaignScope: { mode: 'exclude' },
      limit: 50,
    });
    expect(afterRatify.map((l) => l.statement)).toContain('proposed skill fact');
    const ratified = await getCoachLearningById(db, TENANT_ID, SPACE_ID, skillProposed.learningId);
    expect(ratified?.status).toBe('ratified');
    expect(ratified?.resolvedBy).toBe('operator:test');
  });
});
