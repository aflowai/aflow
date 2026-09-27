import { desc, eq, and, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  CaseDistributionEvidence,
  CoachBreadthEvidence,
  CoachSkillMode,
  CampaignTrajectoryEvidence,
  Campaign,
  CandidateLearning,
  EntityDirectives,
  Outcome,
  SkillGoal,
  TenantId,
  TrajectoryLearningEntry,
} from '@aflow/schemas';
import { resolveCampaignTargetBar } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { bestScoreByDirection } from './promotion.js';
import { parseRunEvaluationEnvelope } from './runEvaluationEnvelope.js';
import { getCampaignById, getCampaignScoreSeries } from './campaigns.js';
import { listCandidatesByCampaign } from './candidateLearnings.js';
import { resolveSkillForWorkflow } from './skill.js';

// ============================================================================
// Pure aggregation — optimization trajectory
// ============================================================================

export function buildTrajectoryEvidence(input: {
  campaign: Campaign;
  series: readonly number[];
  candidates: readonly CandidateLearning[];
  goalThreshold?: number | undefined;
  learningsLimit: number;
}): CampaignTrajectoryEvidence {
  // The ledger lists candidates oldest-first; the evidence carries the
  // NEWEST `learningsLimit` entries, newest first.
  const learnings: TrajectoryLearningEntry[] = [...input.candidates]
    .slice(-Math.max(0, input.learningsLimit))
    .reverse()
    .map((c) => ({
      statement: c.learning.observation,
      kind: c.learning.kind,
      status: c.status,
    }));
  const peak = bestScoreByDirection([...input.series], input.campaign.direction);
  return {
    campaignId: input.campaign.campaignId,
    objective: {
      metricKey: input.campaign.scoreMetricKey,
      direction: input.campaign.direction,
      ...(input.goalThreshold !== undefined ? { threshold: input.goalThreshold } : {}),
    },
    series: [...input.series].slice(-500),
    ...(peak !== undefined ? { peak } : {}),
    learnings,
  };
}

// ============================================================================
// Pure aggregation — process case distribution (stub depth)
// ============================================================================

export interface CaseRunRow {
  runId: string;
  status: string;
  /** The evaluation envelope's `summary.verdict` when an eval graded the run. */
  evalVerdict?: string | undefined;
  /** `metadata.inputClass` when a string — the forward input-taxonomy seam. */
  inputClass?: string | undefined;
}

export interface CaseFailedTaskRow {
  runId: string;
  taskId: string;
  errorCode?: string | undefined;
}

/**
 * Per-input-class pass rate + failure-mode clustering. A case "passes" by its
 * eval verdict when one exists (`pass` only — partial is not goal acceptance),
 * else by run terminal status. Failure modes cluster deterministically on
 * `taskId[:errorCode]` of failed task rows.
 */
export function buildCaseDistribution(
  runs: readonly CaseRunRow[],
  failedTasks: readonly CaseFailedTaskRow[],
): CaseDistributionEvidence {
  const byClass = new Map<string, { runs: number; passes: number }>();
  for (const run of runs) {
    const cls = run.inputClass ?? 'default';
    const entry = byClass.get(cls) ?? { runs: 0, passes: 0 };
    entry.runs += 1;
    const passed =
      run.evalVerdict !== undefined ? run.evalVerdict === 'pass' : run.status === 'completed';
    if (passed) entry.passes += 1;
    byClass.set(cls, entry);
  }

  const byMode = new Map<string, number>();
  for (const task of failedTasks) {
    const category = task.errorCode ? `${task.taskId}:${task.errorCode}` : task.taskId;
    byMode.set(category, (byMode.get(category) ?? 0) + 1);
  }

  return {
    sampleSize: runs.length,
    classes: [...byClass.entries()]
      .sort((a, b) => b[1].runs - a[1].runs)
      .slice(0, 20)
      .map(([inputClass, agg]) => ({
        inputClass,
        runs: agg.runs,
        passRate: agg.runs > 0 ? agg.passes / agg.runs : 0,
      })),
    failureModes: [...byMode.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([category, count]) => ({ category, count })),
  };
}

// ============================================================================
// Loader (thin I/O)
// ============================================================================

export interface LoadBreadthEvidenceParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  mode: 'optimization' | 'process' | 'project';
  /** Present for campaign-keyed (numeric-goal) reviews. */
  campaignId?: string | undefined;
  /** The typed goal, when the caller resolved it (metricKey for the bar lookup). */
  goal?: SkillGoal | null | undefined;
  outcomes?: readonly Outcome[] | undefined;
  /** Named knobs (`learningPolicy.breadthEvidence`). */
  knobs: { caseWindow: number; learningsLimit: number };
}

/**
 * Load the breadth evidence for a review. Returns `null` when the mode has no
 * breadth shape yet (`project` — deferred seam), when an optimization review
 * has no campaign, or when a load fails (graceful omission).
 */
export async function loadBreadthEvidence(
  params: LoadBreadthEvidenceParams,
): Promise<CoachBreadthEvidence | null> {
  try {
    if (params.mode === 'optimization') {
      if (!params.campaignId) return null;
      const campaign = await getCampaignById(params.db, params.tenantId, params.campaignId);
      if (!campaign) return null;
      const [series, candidates] = await Promise.all([
        getCampaignScoreSeries(params.db, params.tenantId, params.campaignId),
        listCandidatesByCampaign(params.db, params.tenantId, params.campaignId),
      ]);
      const bar =
        params.goal?.type === 'numeric' && params.outcomes
          ? resolveCampaignTargetBar(params.outcomes, params.goal.metricKey, campaign.config ?? {})
          : null;
      return {
        mode: 'optimization',
        trajectory: buildTrajectoryEvidence({
          campaign,
          series: series.map((p) => p.score),
          candidates,
          goalThreshold: bar?.target,
          learningsLimit: params.knobs.learningsLimit,
        }),
      };
    }

    if (params.mode === 'process') {
      const tenantCtx = createTenantContext(params.tenantId as TenantId);
      const runRows = await withTenantSchema(params.db, tenantCtx, async (tx) =>
        tx
          .select({
            runId: workflowRuns.runId,
            status: workflowRuns.status,
            evaluationJson: workflowRuns.evaluationJson,
            metadata: workflowRuns.metadata,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.spaceId, params.spaceId),
              eq(workflowRuns.workflowSlug, params.workflowSlug),
              inArray(workflowRuns.status, ['completed', 'failed', 'cancelled']),
            ),
          )
          .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.runId))
          .limit(params.knobs.caseWindow),
      );
      if (runRows.length === 0) return null;

      const runIds = runRows.map((r) => r.runId);
      const failedRows = await withTenantSchema(params.db, tenantCtx, async (tx) =>
        tx
          .select({
            runId: workflowRunTasks.runId,
            taskId: workflowRunTasks.taskId,
            errorCode: workflowRunTasks.errorCode,
          })
          .from(workflowRunTasks)
          .where(
            and(inArray(workflowRunTasks.runId, runIds), eq(workflowRunTasks.status, 'failed')),
          ),
      );

      const runs: CaseRunRow[] = runRows.map((r) => {
        const envelope = parseRunEvaluationEnvelope(r.evaluationJson);
        const metadata = r.metadata as Record<string, unknown> | null;
        const inputClass = metadata?.['inputClass'];
        return {
          runId: r.runId,
          status: r.status,
          ...(envelope?.summary !== undefined ? { evalVerdict: envelope.summary.verdict } : {}),
          ...(typeof inputClass === 'string' && inputClass.length > 0 ? { inputClass } : {}),
        };
      });
      const failedTasks: CaseFailedTaskRow[] = failedRows.map((t) => ({
        runId: t.runId,
        taskId: t.taskId,
        ...(t.errorCode ? { errorCode: t.errorCode } : {}),
      }));

      return { mode: 'process', caseDistribution: buildCaseDistribution(runs, failedTasks) };
    }

    // `project` — deferred seam (183f §5): no breadth shape until the
    // project-state substrate exists.
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Review-time resolution (mode + breadth, one call from the trigger)
// ============================================================================

export interface ResolveBreadthForReviewParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** Mode override from the activation request (operator / Helmsman retrigger). */
  overrideMode: CoachSkillMode | undefined;
  /** Present for campaign-keyed (numeric-goal) reviews. */
  campaignId?: string | undefined;
  directives: EntityDirectives | undefined;
  /** Structural reviews have no performance breadth. */
  isValidityRepair: boolean;
}

export async function resolveBreadthForReview(params: ResolveBreadthForReviewParams): Promise<{
  resolvedSkillMode: CoachSkillMode | undefined;
  breadthEvidence: CoachBreadthEvidence | undefined;
}> {
  let resolvedSkillMode = params.overrideMode;
  let resolvedGoal: SkillGoal | null = null;
  let resolvedOutcomes: readonly Outcome[] | undefined;
  let breadthEvidence: CoachBreadthEvidence | undefined;
  if (params.isValidityRepair) return { resolvedSkillMode, breadthEvidence };

  const { db, tenantId, spaceId, workflowSlug } = params;
  try {
    const skill = await resolveSkillForWorkflow({ db, tenantId, spaceId }, workflowSlug);
    resolvedGoal = skill?.manifest.goal ?? null;
    resolvedOutcomes = skill?.workflow?.outcomes;
    if (!resolvedSkillMode) {
      resolvedSkillMode = skill?.manifest.mode ?? skill?.workflow?.mode;
    }
  } catch {
    // Mode resolution is best-effort — chooseCoachIntent falls back.
  }
  if (resolvedSkillMode) {
    const breadthKnobs = params.directives?.learningPolicy.breadthEvidence;
    const loaded = await loadBreadthEvidence({
      db,
      tenantId,
      spaceId,
      workflowSlug,
      mode: resolvedSkillMode,
      campaignId: params.campaignId,
      goal: resolvedGoal,
      outcomes: resolvedOutcomes,
      knobs: {
        caseWindow: breadthKnobs?.caseWindow ?? 20,
        learningsLimit: breadthKnobs?.learningsLimit ?? 10,
      },
    });
    if (loaded) breadthEvidence = loaded;
  }
  return { resolvedSkillMode, breadthEvidence };
}

// ============================================================================
// Prompt rendering
// ============================================================================

export function formatBreadthEvidenceForPrompt(evidence: CoachBreadthEvidence): string {
  if (evidence.mode === 'optimization') {
    const t = evidence.trajectory;
    const seriesStr = t.series.map((s) => String(s)).join(', ');
    const lines = [
      'Campaign trajectory (breadth tier — read every learning AGAINST this arc):',
      `- objective: ${t.objective.direction} ${t.objective.metricKey}${
        t.objective.threshold !== undefined ? ` (target ${String(t.objective.threshold)})` : ''
      }`,
      `- score series (run order): [${seriesStr}]`,
      ...(t.peak !== undefined ? [`- peak (best-by-direction): ${String(t.peak)}`] : []),
    ];
    if (t.learnings.length > 0) {
      lines.push('- learnings history (candidate ledger, newest first):');
      for (const l of t.learnings) {
        lines.push(`    [${l.status}] (${l.kind}) ${l.statement}`);
      }
    }
    return lines.join('\n');
  }

  const d = evidence.caseDistribution;
  const lines = [
    `Case distribution (breadth tier — last ${String(d.sampleSize)} runs as isolated cases):`,
    ...d.classes.map(
      (c) =>
        `- class "${c.inputClass}": ${String(c.runs)} run(s), pass rate ${(c.passRate * 100).toFixed(0)}%`,
    ),
  ];
  if (d.failureModes.length > 0) {
    lines.push('- recurring failure modes (failed task[:errorCode] × count):');
    for (const f of d.failureModes) {
      lines.push(`    ${f.category} × ${String(f.count)}`);
    }
  }
  return lines.join('\n');
}
