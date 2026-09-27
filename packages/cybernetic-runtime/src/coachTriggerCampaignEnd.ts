import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { EvalBatchSummarySchema } from '@aflow/schemas';
import type {
  Campaign,
  CandidateLearning,
  CoachLearning,
  EvalBatchBaselineDelta,
  EvalBatchDelta,
  EvalBatchSummary,
  TenantId,
} from '@aflow/schemas';
import type { EvalBatchRow } from '@aflow/database';
import { getCampaignById, getCampaignScoreSeries } from './campaigns.js';
import { listCandidatesByCampaign } from './candidateLearnings.js';
import { formatCandidateLedgerForPrompt } from './candidateEvidence.js';
import { bestScoreByDirection } from './promotion.js';
import {
  formatLearningLine,
  loadRecentLearnings,
  type LearningSetStateForPrompt,
} from './facts/index.js';
import { getEvalBaseline, getEvalBatchHead, listEvalBatches } from './evalBatchStore.js';
import {
  buildComparisonForBatches,
  TERMINAL_BATCH_STATUSES,
  toBaselineDelta,
} from './evalBatchView.js';

export interface CampaignMeasurementBatch {
  batchId: string;
  datasetVersion: number;
  workflowRevision: number;
  completedAt?: string;
  /** Terminal scorecard; absent when the batch never summarized. */
  summary?: EvalBatchSummary;
}

/**
 * The skill's offline-batch measurement at campaign end: the latest completed
 * batch's scorecard, the pinned baseline's, and the paired delta between them
 * — present only when at least one completed batch exists (no dataset/batches
 * means no block, never empty-with-zeros).
 */
export interface CampaignMeasurementEvidence {
  latestBatch: CampaignMeasurementBatch;
  baseline?: CampaignMeasurementBatch & { pinnedAt: string };
  /** Present when a baseline is pinned, differs from the latest batch, and both are terminal. */
  baselineDelta?: EvalBatchBaselineDelta;
}

export interface CampaignSynthesisEvidence {
  campaign: Campaign;
  /** Score series in run order (scored runs only). */
  series: number[];
  /** The full candidate ledger for the campaign (pending + resolved). */
  candidates: CandidateLearning[];
  /** The campaign's durable campaign-scope learnings — the survivors of
   *  in-campaign consolidation. */
  campaignSurvivors: CoachLearning[];
  /** The skill's current skill-scope + space-scope set — the durable rows
   *  plus `proposed` ones awaiting ratification, so a synthesis never
   *  re-proposes a claim that already sits in the operator's queue. */
  skillAndSpaceSet: CoachLearning[];
  /** Offline-batch measurement; absent when the skill has no completed batch. */
  measurement?: CampaignMeasurementEvidence;
}

/** Newest-first scan bound when resolving the latest completed batch. */
const MEASUREMENT_BATCH_SCAN_LIMIT = 20;

function toMeasurementBatch(head: EvalBatchRow): CampaignMeasurementBatch {
  const summary = EvalBatchSummarySchema.safeParse(head.summaryJson);
  return {
    batchId: head.id,
    datasetVersion: head.datasetVersion,
    workflowRevision: head.workflowRevision,
    ...(head.completedAt !== null ? { completedAt: head.completedAt.toISOString() } : {}),
    ...(summary.success ? { summary: summary.data } : {}),
  };
}

/**
 * Read-only fold of the skill's batch measurement for the synthesis brief.
 * Returns undefined when no completed batch exists — the packet then simply
 * carries no measurement section.
 */
export async function loadCampaignMeasurementEvidence(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; workflowSlug: string },
): Promise<CampaignMeasurementEvidence | undefined> {
  const heads = await listEvalBatches(db, tenantId as TenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    limit: MEASUREMENT_BATCH_SCAN_LIMIT,
  });
  const latest = heads.find((head) => head.status === 'completed');
  if (latest === undefined) return undefined;

  const evidence: CampaignMeasurementEvidence = { latestBatch: toMeasurementBatch(latest) };
  const baselineRow = await getEvalBaseline(db, tenantId as TenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
  });
  if (baselineRow === null) return evidence;

  if (baselineRow.batchId === latest.id) {
    evidence.baseline = {
      ...evidence.latestBatch,
      pinnedAt: baselineRow.pinnedAt.toISOString(),
    };
    return evidence;
  }
  const baselineHead = await getEvalBatchHead(db, tenantId as TenantId, {
    spaceId: params.spaceId,
    batchId: baselineRow.batchId,
  });
  if (baselineHead === null) return evidence;
  evidence.baseline = {
    ...toMeasurementBatch(baselineHead),
    pinnedAt: baselineRow.pinnedAt.toISOString(),
  };
  if (TERMINAL_BATCH_STATUSES.has(baselineHead.status)) {
    evidence.baselineDelta = toBaselineDelta(
      await buildComparisonForBatches(db, tenantId as TenantId, baselineHead, latest),
    );
  }
  return evidence;
}

/**
 * Load the deterministic evidence for a campaign-end synthesis brief.
 * Best-effort — returns `null` when the campaign cannot be read, so the
 * review degrades to the generic brief instead of failing the trigger.
 *
 * The two learning partitions are loaded with separate scoped reads, not one
 * partitioned read: each gets its own recency window, so a learning-heavy
 * campaign cannot evict the skill/space set (or vice versa).
 */
export async function loadCampaignSynthesisEvidence(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  campaignId: string;
}): Promise<CampaignSynthesisEvidence | null> {
  const { db, tenantId, spaceId, workflowSlug, campaignId } = params;
  try {
    const campaign = await getCampaignById(db, tenantId, campaignId);
    if (!campaign) return null;
    const learningsBase = { db, tenantId, spaceId, workflowSlug };
    const [seriesPoints, candidates, campaignSurvivors, skillAndSpaceSet] = await Promise.all([
      getCampaignScoreSeries(db, tenantId, campaignId),
      listCandidatesByCampaign(db, tenantId, campaignId),
      loadRecentLearnings({
        ...learningsBase,
        campaignScope: { mode: 'campaign-only', campaignId },
      }),
      loadRecentLearnings({
        ...learningsBase,
        campaignScope: { mode: 'exclude' },
        includeProposed: true,
      }),
    ]);
    let measurement: CampaignMeasurementEvidence | undefined;
    try {
      measurement = await loadCampaignMeasurementEvidence(db, tenantId, {
        spaceId,
        workflowSlug,
      });
    } catch {
      // The packet renders without the measurement section rather than degrading to the generic brief.
    }
    return {
      campaign,
      series: seriesPoints.map((p) => p.score),
      candidates,
      campaignSurvivors,
      skillAndSpaceSet,
      ...(measurement !== undefined ? { measurement } : {}),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Measurement rendering
// ============================================================================

function formatShare(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatMeasurementDelta(label: string, delta: EvalBatchDelta): string {
  return (
    `${label} ${formatShare(delta.rateA)} → ${formatShare(delta.rateB)} ` +
    `(Δ ${delta.delta >= 0 ? '+' : ''}${(delta.delta * 100).toFixed(1)}pp, ` +
    `95% CI [${(delta.intervalLower * 100).toFixed(1)}pp, ${(delta.intervalUpper * 100).toFixed(1)}pp])`
  );
}

function formatMeasurementBatchLine(prefix: string, batch: CampaignMeasurementBatch): string {
  const summary = batch.summary;
  const scoreParts =
    summary !== undefined
      ? [
          ...(summary.passRate !== undefined ? [`pass rate ${formatShare(summary.passRate)}`] : []),
          ...(summary.passAllTrialsRate !== undefined
            ? [`pass^k ${formatShare(summary.passAllTrialsRate)}`]
            : []),
          ...(summary.passAnyTrialRate !== undefined
            ? [`pass@k ${formatShare(summary.passAnyTrialRate)}`]
            : []),
          `${String(summary.cases)} case(s) × ${String(summary.trialsPerCase)} trial(s)`,
        ]
      : ['no scorecard recorded'];
  return `- ${prefix} ${batch.batchId} (dataset v${String(batch.datasetVersion)}, revision ${String(batch.workflowRevision)}): ${scoreParts.join(' · ')}`;
}

/**
 * The measurement section of the synthesis packet — rendered only when the
 * skill has a completed batch (`evidence.measurement` present).
 */
export function formatCampaignMeasurementLines(measurement: CampaignMeasurementEvidence): string[] {
  const lines = [
    '### Offline measurement (frozen eval batches)',
    formatMeasurementBatchLine('latest completed batch', measurement.latestBatch),
  ];
  if (measurement.baseline === undefined) {
    lines.push('- no baseline pinned — deltas need an operator-pinned ruler');
    return lines;
  }
  if (measurement.baseline.batchId === measurement.latestBatch.batchId) {
    lines.push(`- this batch IS the pinned baseline (pinned ${measurement.baseline.pinnedAt})`);
    return lines;
  }
  lines.push(
    formatMeasurementBatchLine(
      `pinned baseline (pinned ${measurement.baseline.pinnedAt})`,
      measurement.baseline,
    ),
  );
  const delta = measurement.baselineDelta;
  if (delta === undefined) {
    lines.push('- no baseline delta — the baseline batch is not terminal');
    return lines;
  }
  const deltaParts = [
    ...(delta.perCaseSuccess !== undefined
      ? [formatMeasurementDelta('pass^k', delta.perCaseSuccess)]
      : []),
    ...(delta.trialPass !== undefined
      ? [formatMeasurementDelta('per-trial', delta.trialPass)]
      : []),
    `flips ${String(delta.passToFailFlips)} pass→fail / ${String(delta.failToPassFlips)} fail→pass` +
      (delta.investigationFlips > 0
        ? ` (${String(delta.investigationFlips)} need transcript investigation)`
        : ''),
    `n=${String(delta.pairedCases)} paired case(s)`,
  ];
  lines.push(`- vs baseline: ${deltaParts.join(' · ')}`, `- ${delta.uncertaintyNote}`);
  return lines;
}

/**
 * Render the campaign synthesis packet — the deterministic brief for a
 * campaign-end review. Replaces the per-run diagnosis packet: campaign
 * identity + outcome, the campaign-scope survivors, the unresolved candidate
 * ledger, and the skill's current skill/space-scope durable set (so the Coach
 * generalizes without duplicating).
 */
export function formatCampaignSynthesisForPrompt(input: {
  evidence: CampaignSynthesisEvidence;
  setState?: LearningSetStateForPrompt;
}): string {
  const { campaign, series, candidates, campaignSurvivors, skillAndSpaceSet } = input.evidence;

  const peak = bestScoreByDirection(series, campaign.direction);
  const finalScore = series[series.length - 1];
  const outcomeLine = [
    `- scored runs: ${String(series.length)}`,
    `- score series (run order): [${series.map((s) => String(s)).join(', ')}]`,
    ...(finalScore !== undefined
      ? [
          `- final: ${String(finalScore)}${peak !== undefined ? ` · peak (best-by-direction): ${String(peak)}` : ''}`,
        ]
      : []),
  ];

  const candidateBlock = formatCandidateLedgerForPrompt(candidates, { campaignEnded: true });

  const lines = [
    '## Campaign synthesis packet',
    '',
    `Campaign ${campaign.campaignId} of skill "${campaign.workflowSlug}" — ended (${campaign.endedReason ?? 'unknown'}).`,
    `- objective: ${campaign.direction} ${campaign.scoreMetricKey}`,
    `- started ${campaign.startedAt}${campaign.endedAt ? ` · ended ${campaign.endedAt}` : ''}`,
    ...(campaign.config && Object.keys(campaign.config).length > 0
      ? [`- config: ${JSON.stringify(campaign.config)}`]
      : []),
    '',
    '### Campaign trajectory',
    ...(series.length > 0 ? outcomeLine : ['- no scored runs']),
    ...(input.evidence.measurement !== undefined
      ? ['', ...formatCampaignMeasurementLines(input.evidence.measurement)]
      : []),
    '',
    '### Campaign-scope learnings (survivors of in-campaign consolidation — they retire with the campaign)',
    ...(campaignSurvivors.length > 0 ? campaignSurvivors.map(formatLearningLine) : ['(none)']),
    '',
    '### Candidate ledger',
    ...(candidateBlock ? [candidateBlock] : ['(no unresolved candidates)']),
    '',
    '### Current skill-scope + space-scope set (already generalizes — do not duplicate; [pending ratification] entries await operator review)',
    ...(skillAndSpaceSet.length > 0 ? skillAndSpaceSet.map(formatLearningLine) : ['(none yet)']),
  ];

  if (input.setState) {
    lines.push(
      '',
      `Active injected set: ${String(input.setState.activeSetSize)} of budget ${String(input.setState.budget)}${
        input.setState.consolidationDue
          ? ' — over budget, consolidation due (learner.learning.consolidate)'
          : ''
      }.`,
    );
  }

  return lines.join('\n');
}

export function buildCampaignEndReviewPromptParts(params: {
  workflowSlug: string;
  campaignId: string;
  reason: string;
}): string[] {
  return [
    `Campaign ${params.campaignId} of skill "${params.workflowSlug}" has ended: ${params.reason}.`,
    'This is a campaign-end synthesis review, not a run diagnosis — decide what survives the campaign. The campaign synthesis packet below is the deterministic brief: record skill-scope learnings for claims that generalize beyond this campaign, resolve the still-pending candidates, and consolidate duplicates or contradictions in the campaign set. Read the run ledger with artifact.inspect.* only when the packet leaves a claim unpinned.',
  ];
}
