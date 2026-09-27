import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  Campaign,
  CampaignEndedReason,
  MaterializedSkillGoal,
  Outcome,
  Workflow,
  WorkflowLearning,
  CompactEvalOutcome,
  CandidateLearning,
} from '@aflow/schemas';
import {
  compareWithThresholdOperator,
  resolveCampaignGoal,
  resolveCampaignTargetBar,
} from '@aflow/schemas';
import { resolveWorkflowForStart } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { getCyberneticLogger } from './logger.js';
import { resolveSkillForWorkflow } from './skill.js';
import {
  resolvePromotedRunMetrics,
  derivePrimaryScore,
  bestScoreByDirection,
  type PromotionTaskResult,
  type RunLevelMetrics,
} from './promotion.js';
import {
  getCampaignById,
  getCampaignScoreSeries,
  listCampaigns,
  endCampaign,
} from './campaigns.js';
import { writeCandidateLearnings } from './candidateLearnings.js';
import { updateRunMetadata } from './ledger/runs.js';
import { getRunCampaignId } from './ledger/queries.js';

export interface PrepareRunScoringParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  taskResults: readonly PromotionTaskResult[];
}

export interface PrepareRunScoringResult {
  workflow: Workflow | null;
  goal: MaterializedSkillGoal | null;
  runLevelMetrics: RunLevelMetrics;
  /** Set only for campaign-eligible runs (numeric goal). */
  campaign: Campaign | null;
}

export async function prepareRunScoring(
  params: PrepareRunScoringParams,
): Promise<PrepareRunScoringResult> {
  const { db, tenantId, spaceId, workflowSlug, runId, taskResults } = params;
  const logger = getCyberneticLogger();

  let workflow: Workflow | null = null;
  try {
    workflow = await resolveWorkflowForStart(db, tenantId as TenantId, spaceId, workflowSlug);
  } catch (err) {
    logger.debug(
      `[scoreFinalize] resolveWorkflowForStart failed for ${workflowSlug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let campaign: Campaign | null = null;
  try {
    const campaignId = await getRunCampaignId(db, tenantId, runId);
    if (campaignId) {
      campaign = await getCampaignById(db, tenantId, campaignId);
      if (!campaign) {
        logger.warn(
          `[scoreFinalize] run ${runId} references campaign ${campaignId} but no campaign row exists`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[scoreFinalize] campaign read failed for ${workflowSlug} run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let goal: MaterializedSkillGoal | null = null;
  try {
    const skill = await resolveSkillForWorkflow({ db, tenantId, spaceId }, workflowSlug);
    if (skill) {
      const resolved = resolveCampaignGoal(skill.manifest, campaign?.config ?? {});
      if (resolved.ok) {
        goal = resolved.goal;
      } else {
        logger.warn(
          `[scoreFinalize] goal materialization failed for ${workflowSlug} run=${runId}: ${resolved.reason}`,
        );
      }
    }
  } catch (err) {
    logger.debug(
      `[scoreFinalize] resolveSkillForWorkflow failed for ${workflowSlug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (campaign === null && goal?.type === 'numeric') {
    logger.warn(
      `[scoreFinalize] run ${runId} of ${workflowSlug} has a numeric goal but no campaignId — ` +
        'start-time resolution did not run (pre-195 run?); skipping campaign-keyed writes',
    );
  }

  const runLevelMetrics = workflow ? resolvePromotedRunMetrics(workflow.tasks, taskResults) : {};

  return { workflow, goal, runLevelMetrics, campaign };
}

export interface MaterializeRunScoreParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  goal: MaterializedSkillGoal | null;
  campaign: Campaign | null;
  outcomes?: readonly Outcome[];
  runLevelMetrics: RunLevelMetrics;
  evalResult?: {
    resultId?: string;
    overall?: number;
    verdict?: 'pass' | 'fail' | 'partial' | 'error';
    regressionDetected?: boolean;
  } | null;
  /** The run's recorded learnings (from `workflow_runs.learnings_json`). */
  learnings: readonly WorkflowLearning[];
  /**
   * The run's terminal status (`workflow_runs.status`). Drives the
   * completion-default score: a campaign run that produced no real score still
   * gets one from its outcome. See {@link materializeRunScore}.
   */
  runTerminalStatus?: 'completed' | 'failed' | 'cancelled';
}

export interface MaterializeRunScoreResult {
  score: number | null;
  candidates: CandidateLearning[];
  /** Set only when THIS finalize transitioned the campaign to ended (the
   *  goal-met CAS won) — the caller dispatches the campaign-end review. */
  campaignEnded?: { campaignId: string; reason: CampaignEndedReason };
}

/**
 * Phase B (after eval). Derives the primary numeric score + provenance from the
 * typed goal, writes them to `workflow_runs`, and writes each run learning as a
 * `pending` candidate in the ledger (campaign-keyed when the run belongs to a
 * campaign, skill-keyed otherwise; carrying a compact eval outcome).
 */
export async function materializeRunScore(
  params: MaterializeRunScoreParams,
): Promise<MaterializeRunScoreResult> {
  const {
    db,
    tenantId,
    spaceId,
    workflowSlug,
    runId,
    goal,
    campaign,
    outcomes,
    runLevelMetrics,
    evalResult,
    learnings,
    runTerminalStatus,
  } = params;
  const logger = getCyberneticLogger();

  let score: number | null = null;
  if (goal) {
    const derived = derivePrimaryScore(goal, runLevelMetrics, {
      ...(evalResult?.overall !== undefined ? { normalizedScore: evalResult.overall } : {}),
      ...(evalResult?.resultId !== undefined ? { evalResultRef: evalResult.resultId } : {}),
    });
    if (derived) {
      score = derived.score;
      try {
        await updateRunMetadata(db, tenantId, {
          runId,
          score: derived.score,
          scoreProvenance: derived.provenance,
        });
      } catch (err) {
        logger.warn(
          `[scoreFinalize] score write failed for run=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Completion-default score — a strict FALLBACK, never an override. The
  // platform evaluates everything so it can learn, so a campaign run that
  // derived no real score (no produced metric, no eval overall) still earns a
  // score from its terminal outcome: succeeded ⇒ 1, failed ⇒ 0. This fires
  // ONLY when `score === null`, so a real produced/eval score always wins —
  // any future deterministic/eval/operator scorer is purely additive: it just
  // makes a real score exist, and that overrides this default with no rebuild.
  // The `completion_default` provenance keeps it auditable + distinguishable
  // from a metric score on read. Gated to NON-numeric goals: a numeric (e.g.
  // Kaggle) campaign run that produced no metric stays `null` (genuinely
  // "no score yet" — excluded from the series, as before), never a fabricated
  // 1/0 that would perturb regression/best-score or spuriously meet the target.
  if (campaign && score === null && runTerminalStatus !== undefined && goal?.type !== 'numeric') {
    const completionScore = runTerminalStatus === 'completed' ? 1 : 0;
    score = completionScore;
    try {
      await updateRunMetadata(db, tenantId, {
        runId,
        score: completionScore,
        scoreProvenance: { kind: 'completion_default', terminalStatus: runTerminalStatus },
      });
    } catch (err) {
      logger.warn(
        `[scoreFinalize] completion-default score write failed for run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let campaignEnded: MaterializeRunScoreResult['campaignEnded'];
  if (campaign && score !== null && goal?.type === 'numeric') {
    const bar = resolveCampaignTargetBar(outcomes ?? [], goal.metricKey, campaign.config ?? {});
    if (bar && compareWithThresholdOperator(score, bar.operator, bar.target, bar.targetHigh)) {
      try {
        const ended = await endCampaign(db, tenantId, campaign.campaignId, 'goal_met');
        if (ended) {
          campaignEnded = { campaignId: campaign.campaignId, reason: 'goal_met' };
        }
      } catch (err) {
        logger.warn(
          `[scoreFinalize] endCampaign(goal_met) failed for campaign=${campaign.campaignId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  let candidates: CandidateLearning[] = [];
  if (learnings.length > 0) {
    const compactEvalOutcome: CompactEvalOutcome = {
      ...(evalResult?.verdict !== undefined ? { verdict: evalResult.verdict } : {}),
      ...(evalResult?.overall !== undefined ? { overallScore: evalResult.overall } : {}),
      ...(score !== null ? { score } : {}),
      ...(evalResult?.regressionDetected !== undefined
        ? { regressionDetected: evalResult.regressionDetected }
        : {}),
    };
    try {
      candidates = await writeCandidateLearnings(db, tenantId, {
        spaceId,
        skillSlug: workflowSlug,
        ...(campaign ? { campaignId: campaign.campaignId } : {}),
        runId,
        learnings,
        ...(Object.keys(compactEvalOutcome).length > 0 ? { compactEvalOutcome } : {}),
      });
    } catch (err) {
      logger.warn(
        `[scoreFinalize] candidate write failed for run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { score, candidates, ...(campaignEnded ? { campaignEnded } : {}) };
}

export async function resolveBestScoreForWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  workflowSlug: string,
  opts: { campaignId?: string } = {},
): Promise<number | undefined> {
  let campaign: Campaign | null = null;
  if (opts.campaignId !== undefined) {
    campaign = await getCampaignById(db, tenantId, opts.campaignId);
    if (campaign && (campaign.spaceId !== spaceId || campaign.workflowSlug !== workflowSlug)) {
      campaign = null;
    }
  } else {
    const active = await listCampaigns(db, tenantId, {
      spaceId,
      workflowSlug,
      status: 'active',
      limit: 2,
    });
    if (active.length === 1) campaign = active[0]!;
  }
  if (!campaign) return undefined;
  const series = await getCampaignScoreSeries(db, tenantId, campaign.campaignId);
  return bestScoreByDirection(
    series.map((p) => p.score),
    campaign.direction,
  );
}
