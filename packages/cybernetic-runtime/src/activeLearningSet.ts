import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ActiveLearning, EntityDirectives, WorkflowLearning } from '@aflow/schemas';
import { DirectiveLearningPolicySchema, isFastInjectLearningKind } from '@aflow/schemas';
import { getCampaignById, getCampaignScoreSeries, listCampaigns } from './campaigns.js';
import { listCandidatesByCampaign } from './candidateLearnings.js';
import { getRunLearningScope, listTerminalRunLearningsForCampaign } from './ledger/queries.js';
import { listDurableCoachLearnings, countDurableCoachLearnings } from './coachLearningsStore.js';
import { loadSpaceDirectives } from './modelResolution.js';
import { bestScoreByDirection } from './promotion.js';

const TRAJECTORY_RECENT_SCORES = 5;

export interface SelectActiveLearningSetParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  skillSlug: string;
  campaignId?: string;
  /** Task-targeted reads (Runner injection) exclude learnings targeted at
   *  other tasks; omitted (operator / ledger / Coach reads) = unfiltered. */
  taskId?: string;
  budget: number;
}

export interface ActiveLearningSet {
  selected: ActiveLearning[];
  omittedDueToBudget: number;
  consolidationDue: boolean;
}

export function resolveActiveSetBudget(directives: EntityDirectives | null | undefined): number {
  const parsed = DirectiveLearningPolicySchema.safeParse(directives?.learningPolicy ?? {});
  return parsed.success
    ? parsed.data.activeSetBudget
    : DirectiveLearningPolicySchema.parse({}).activeSetBudget;
}

interface CandidateTierEntry {
  runId: string;
  learning: WorkflowLearning;
  at: string;
}

function candidateIdentity(runId: string, learningId: string): string {
  return `${runId}:${learningId}`;
}

function candidateAppliesToTask(learning: WorkflowLearning, taskId: string | undefined): boolean {
  if (taskId === undefined) return true;
  const targets = learning.appliesToTaskIds;
  return targets === undefined || targets.length === 0 || targets.includes(taskId);
}

/**
 * The one read authority for "active learnings" — recompute-at-read, no
 * materialized mirror. Composition in priority order (truncation drops from
 * the bottom, never the top):
 *
 * 1. Trajectory header (campaign only) — never truncated, never counted
 *    against the budget.
 * 2. Durable learnings (auto_recorded | ratified; space / skill /
 *    campaign-scoped).
 * 3. Pending fast-inject candidates ∪ a read-through of recent terminal
 *    runs' `learnings_json` not yet materialized into candidate rows —
 *    deduped by the candidate identity `(runId, learningId)`, so injection
 *    never waits on, and never misses, the async post-run hooks.
 */
export async function selectActiveLearningSet(
  params: SelectActiveLearningSetParams,
): Promise<ActiveLearningSet> {
  const { db, tenantId, spaceId, skillSlug, campaignId, taskId, budget } = params;

  const selected: ActiveLearning[] = [];

  // A caller-supplied campaignId is only honored when the campaign belongs to
  // the (space, skill) being read — otherwise a foreign campaign's trajectory,
  // candidates, and durable learnings would leak into this skill's set.
  const campaignById =
    campaignId !== undefined ? await getCampaignById(db, tenantId, campaignId) : null;
  const campaign =
    campaignById !== null &&
    campaignById.spaceId === spaceId &&
    campaignById.workflowSlug === skillSlug
      ? campaignById
      : null;

  if (campaign !== null) {
    const series = await getCampaignScoreSeries(db, tenantId, campaign.campaignId);
    const peak = bestScoreByDirection(
      series.map((p) => p.score),
      campaign.direction,
    );
    selected.push({
      kind: 'trajectory',
      objective: { metricKey: campaign.scoreMetricKey, direction: campaign.direction },
      ...(peak !== undefined ? { peak } : {}),
      recentScores: series.slice(-TRAJECTORY_RECENT_SCORES).map((p) => p.score),
    });
  }

  const corpusFilter = {
    spaceId,
    skillSlug,
    campaignScope:
      campaign !== null
        ? ({ mode: 'campaign', campaignId: campaign.campaignId } as const)
        : ({ mode: 'exclude' } as const),
  };
  const durableFilter = taskId !== undefined ? { ...corpusFilter, taskId } : corpusFilter;
  const [durableCorpusTotal, durableApplicableCount, durable] = await Promise.all([
    countDurableCoachLearnings(db, tenantId, corpusFilter),
    taskId !== undefined ? countDurableCoachLearnings(db, tenantId, durableFilter) : null,
    listDurableCoachLearnings(db, tenantId, { ...durableFilter, limit: budget }),
  ]);
  const durableApplicableTotal = durableApplicableCount ?? durableCorpusTotal;

  const candidateTier: CandidateTierEntry[] = [];
  if (campaign !== null) {
    const allCandidates = await listCandidatesByCampaign(db, tenantId, campaign.campaignId);
    const seen = new Set(allCandidates.map((c) => candidateIdentity(c.runId, c.learning.id)));
    for (const c of allCandidates) {
      if (c.status !== 'pending') continue;
      if (!isFastInjectLearningKind(c.learning.kind)) continue;
      if (!candidateAppliesToTask(c.learning, taskId)) continue;
      candidateTier.push({ runId: c.runId, learning: c.learning, at: c.createdAt });
    }
    // Bound derivation: the tier never keeps more than `budget` entries and,
    // absent task targeting, each fetched run contributes ≥1 — so the newest
    // `budget` learning-bearing runs cover every keepable entry. A targeted
    // read can under-fill this window, but only until the async post-run hook
    // materializes candidate rows, which are read unbounded above.
    const runRows = await listTerminalRunLearningsForCampaign(db, tenantId, campaign.campaignId, {
      limit: budget,
    });
    for (const row of runRows) {
      const learnings = Array.isArray(row.learningsJson)
        ? (row.learningsJson as WorkflowLearning[])
        : [];
      for (const learning of learnings) {
        if (!isFastInjectLearningKind(learning.kind)) continue;
        if (!candidateAppliesToTask(learning, taskId)) continue;
        const identity = candidateIdentity(row.runId, learning.id);
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidateTier.push({
          runId: row.runId,
          learning,
          at: row.completedAt?.toISOString() ?? new Date().toISOString(),
        });
      }
    }
    candidateTier.sort((a, b) => b.at.localeCompare(a.at));
  }

  const budgeted: ActiveLearning[] = [];
  for (const l of durable) {
    budgeted.push({
      kind: 'durable',
      learningId: l.learningId,
      statement: l.statement,
      learningKind: l.kind,
      confidence: l.confidence,
      scopeKind: l.scope.kind,
      ...(l.detailRef ? { detailRef: l.detailRef } : {}),
    });
  }
  for (const c of candidateTier) {
    budgeted.push({
      kind: 'candidate',
      runId: c.runId,
      learningId: c.learning.id,
      category: c.learning.category,
      observation: c.learning.observation,
      ...(c.learning.recommendation ? { recommendation: c.learning.recommendation } : {}),
      confidence: c.learning.confidence,
      ...(c.learning.detailRef ? { detailRef: c.learning.detailRef } : {}),
    });
  }

  const kept = budgeted.slice(0, budget);
  selected.push(...kept);

  return {
    selected,
    // The store filters targeting, so the omitted count sees only applicable
    // rows; consolidation pressure is a corpus property, so it stays on the
    // unfiltered durable count.
    omittedDueToBudget: durableApplicableTotal + candidateTier.length - kept.length,
    consolidationDue: durableCorpusTotal > budget,
  };
}

export interface SelectActiveLearningSetForRunParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  skillSlug: string;
  runId?: string;
  taskId?: string;
}

/**
 * Run-scoped entry point: resolves the campaign from the run and the budget
 * from the space's learning policy, then delegates to
 * {@link selectActiveLearningSet}.
 *
 * Frozen mode (Plan 269 D5): a run carrying `evalBatchId` reads NO live
 * learning state — injection resolves to the case fixture's declaration
 * only (default `'none'`; a pinned set is materialized by the batch engine,
 * never read through here). Stationarity is what makes trials comparable.
 */
export async function selectActiveLearningSetForRun(
  params: SelectActiveLearningSetForRunParams,
): Promise<ActiveLearningSet> {
  const { db, tenantId, spaceId, skillSlug, runId, taskId } = params;
  const scope = runId !== undefined ? await getRunLearningScope(db, tenantId, runId) : null;
  if (scope?.evalBatchId != null) {
    return { selected: [], omittedDueToBudget: 0, consolidationDue: false };
  }
  const campaignId = scope?.campaignId ?? null;
  const directives = await loadSpaceDirectives(db, tenantId, spaceId);
  return selectActiveLearningSet({
    db,
    tenantId,
    spaceId,
    skillSlug,
    ...(campaignId !== null ? { campaignId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    budget: resolveActiveSetBudget(directives),
  });
}

export interface SelectActiveLearningSetForSkillParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  skillSlug: string;
  campaignId?: string;
}

/**
 * Skill-scoped entry point (operator / ledger reads): an explicit campaignId
 * wins; otherwise the skill's active campaign — at most one per (space,
 * skill) — scopes the set, and an ended campaign never does. Resolves the
 * budget from the space's learning policy, then delegates to
 * {@link selectActiveLearningSet}.
 */
export async function selectActiveLearningSetForSkill(
  params: SelectActiveLearningSetForSkillParams,
): Promise<ActiveLearningSet> {
  const { db, tenantId, spaceId, skillSlug, campaignId } = params;
  const resolvedCampaignId =
    campaignId ??
    (
      await listCampaigns(db, tenantId, {
        spaceId,
        workflowSlug: skillSlug,
        status: 'active',
        limit: 1,
      })
    )[0]?.campaignId;
  const directives = await loadSpaceDirectives(db, tenantId, spaceId);
  return selectActiveLearningSet({
    db,
    tenantId,
    spaceId,
    skillSlug,
    ...(resolvedCampaignId !== undefined ? { campaignId: resolvedCampaignId } : {}),
    budget: resolveActiveSetBudget(directives),
  });
}
