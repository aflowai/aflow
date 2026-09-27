/**
 * Label-queue planning (Plan 269 D10) — pure decisions over row snapshots.
 * The uniform random slice here is the ONLY minter of partition
 * 'validation': a confusion matrix over any enriched stream estimates the
 * enrichment, not the population. The draw is seeded from the batch id, so
 * a crash-retry of terminalization re-derives the identical draw — persisted
 * once, never re-rolled.
 */
import type {
  CaseRubric,
  EvalBatchProvenanceManifest,
  EvalCaseTrialResults,
  EvalLabelPartition,
  EvalLabelQueueEvidence,
  EvalLabelQueueSource,
  EvalLabelQueueStatus,
  GoldenCaseRevision,
} from '@aflow/schemas';
import { EvalCaseTrialResultsSchema } from '@aflow/schemas';
import { manifestJudgeVersionKey, rubricCriterionId, rubricScopeKey } from './evalBatchJudge.js';

export interface LabelQueueStreamDisclosure {
  partition: EvalLabelPartition | null;
  source: EvalLabelQueueSource | null;
  inclusionProbability: number | null;
}

/**
 * What a queue listing may say about an item's origin. The three stream
 * fields are one disclosure, not three: `planLabelQueueForBatch` mints an
 * exemplar row ONLY from a judged 'fail', so partition 'exemplar', any
 * non-random source and a null inclusionProbability each name the judge's
 * verdict with certainty — withholding one while shipping another buys
 * nothing. Pre-label the whole group is withheld; the resolved row carries
 * it in full, as the record of which stream produced the label.
 */
export function discloseLabelQueueStreamForList(
  status: EvalLabelQueueStatus,
  item: {
    partition: EvalLabelPartition;
    source: EvalLabelQueueSource;
    inclusionProbability: number | null;
  },
): LabelQueueStreamDisclosure {
  if (status === 'pending') return { partition: null, source: null, inclusionProbability: null };
  return {
    partition: item.partition,
    source: item.source,
    inclusionProbability: item.inclusionProbability,
  };
}

/**
 * Default slice share of the batch's trials: the labeling budget grows with
 * batch size while staying a small fraction of it.
 */
export const VALIDATION_SLICE_DEFAULT_SHARE = 0.1;
/**
 * Floor on the derived default: below this a slice cannot seed even a
 * coarse interval, so small batches still contribute validation labels.
 */
export const VALIDATION_SLICE_FLOOR = 5;

/**
 * Effective validation-slice size for a batch: the operator's explicit knob
 * verbatim (0 opts out), else share × (cases × trials) with the floor,
 * never more than the batch holds.
 */
export function deriveValidationSliceSize(params: {
  caseCount: number;
  trialsPerCase: number;
  requested?: number | undefined;
}): number {
  const totalTrials = params.caseCount * params.trialsPerCase;
  if (params.requested !== undefined) return Math.min(params.requested, totalTrials);
  return Math.min(
    totalTrials,
    Math.max(VALIDATION_SLICE_FLOOR, Math.ceil(totalTrials * VALIDATION_SLICE_DEFAULT_SHARE)),
  );
}

function manifestJudgeVersion(
  manifest: EvalBatchProvenanceManifest,
  rubric: CaseRubric,
  caseRevisionId: string,
): string | undefined {
  return manifest.judgeVersions[manifestJudgeVersionKey(rubric, caseRevisionId)];
}

// ============================================================================
// Planning
// ============================================================================

export interface LabelQueueTrialRow {
  caseRevisionId: string;
  trial: number;
  runId: string | null;
  disposition: string;
  verdict: string | null;
  resultsJson: unknown;
}

export interface EvalLabelQueuePlanItem {
  caseRevisionId: string;
  trial: number;
  runId: string | null;
  criterionId: string;
  scopeKey: string;
  partition: EvalLabelPartition;
  source: EvalLabelQueueSource;
  inclusionProbability?: number;
  judgeVersion?: string;
  /** Snapshotted at mint so the item outlives its fixture space. */
  conversation?: { request: string | null; reply: string | null };
  /**
   * The judge's whole pack, frozen at mint. The run it is built from is
   * collected hours later, so an item without this can only be reviewed from
   * the exchange — and a label read from a narrower pack than the judge's
   * measures the evidence gap, not the judge.
   */
  evidence?: EvalLabelQueueEvidence;
}

function itemKey(item: {
  caseRevisionId: string;
  trial: number;
  criterionId: string;
  scopeKey: string;
}): string {
  return `${item.caseRevisionId} ${String(item.trial)} ${item.criterionId} ${item.scopeKey}`;
}

function parseTrialResults(resultsJson: unknown): EvalCaseTrialResults | null {
  const parsed = EvalCaseTrialResultsSchema.safeParse(resultsJson);
  return parsed.success ? parsed.data : null;
}

/**
 * The judge classifier in the batch lane only ever runs on trials whose
 * deterministic contract passed (fails short-circuit it), so that IS the
 * population a validation slice must sample: graded, deterministic-pass,
 * carrying at least one rubric slot.
 *
 * Read from the CHECKS, never from the folded verdict. A judge decides a trial
 * now, so `verdict === 'fail'` covers a trial whose checks all passed and whose
 * judge failed it — exactly the trial the draw most needs to be able to pick.
 * Gating on the verdict removes those from the population and enriches the
 * sample toward judge-pass, which is the one thing a scorecard cannot survive:
 * precision, recall and κ would be computed over a sample selected by the
 * thing they are measuring. A rubric-only trial has no checks to fail and so
 * belongs here too.
 */
/**
 * What the deterministic instrument said about one trial — and `unknown` when
 * it cannot be told.
 *
 * The count is compared against what the case DECLARES, because the array
 * predicates lie in opposite directions on a partial record: `every(passed)`
 * is vacuously true on an empty one, so a case declaring three checks whose
 * results recorded none reads as a clean pass, and `some(!passed)` is
 * vacuously false, so the same record reads as nothing having failed. A
 * rubric-only case declares none and records none, and is `passed`.
 */
function deterministicOutcome(
  row: LabelQueueTrialRow,
  revision: GoldenCaseRevision | undefined,
): 'passed' | 'failed' | 'unknown' {
  if (revision === undefined) return 'unknown';
  const results = parseTrialResults(row.resultsJson);
  if (results === null) return 'unknown';
  if (results.expectationResults.length !== revision.case.expectations.length) return 'unknown';
  return results.expectationResults.some((entry) => !entry.passed) ? 'failed' : 'passed';
}

export function isValidationSliceEligible(
  row: LabelQueueTrialRow,
  revision: GoldenCaseRevision | undefined,
): boolean {
  if (row.disposition !== 'graded') return false;
  // A grader fault is not a judged trial; there is nothing to label.
  if (row.verdict === 'error') return false;
  if (revision === undefined || revision.case.rubrics.length === 0) return false;
  return deterministicOutcome(row, revision) === 'passed';
}

/**
 * Plan every queue item one terminalizing batch mints, validation slice
 * first:
 *
 * - VALIDATION: a uniform without-replacement draw of `sliceSize` eligible
 *   trials (Fisher–Yates under the injected RNG), each drawn trial fanning
 *   out to one item per rubric slot with the shared inclusion probability
 *   n/|eligible| recorded. A judge-failed trial in the draw stays
 *   validation — excluding it would enrich the sample toward judge-pass.
 * - EXEMPLAR: every judged 'fail' rubric outcome routes to the queue as
 *   diagnostic material. Agreement is judged at the CASE level — a judged
 *   trial is always deterministic-pass (fails short-circuit the judge stage,
 *   so trial-level agreement is structurally empty): `judge_fail` when a
 *   sibling trial of the same case failed deterministically (the judge
 *   agrees with the instrument's case-level finding), `judge_disagreement`
 *   when every graded trial of the case passed (the judge contradicts a
 *   uniformly passing case). A subject already drawn into the validation
 *   slice keeps partition 'validation' (the draw is the stronger claim); the
 *   exemplar duplicate is dropped.
 */
export function planLabelQueueForBatch(params: {
  trialRows: readonly LabelQueueTrialRow[];
  revisionsById: ReadonlyMap<string, GoldenCaseRevision>;
  manifest: EvalBatchProvenanceManifest;
  validationSliceSize: number;
  rng: () => number;
}): EvalLabelQueuePlanItem[] {
  const { trialRows, revisionsById, manifest, validationSliceSize, rng } = params;
  const items: EvalLabelQueuePlanItem[] = [];
  const claimed = new Set<string>();

  const eligible = trialRows.filter((row) =>
    isValidationSliceEligible(row, revisionsById.get(row.caseRevisionId)),
  );
  const drawCount = Math.min(validationSliceSize, eligible.length);
  if (drawCount > 0) {
    const shuffled = [...eligible];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const inclusionProbability = drawCount / eligible.length;
    for (const row of shuffled.slice(0, drawCount)) {
      const revision = revisionsById.get(row.caseRevisionId)!;
      for (const rubric of revision.case.rubrics) {
        const judgeVersion = manifestJudgeVersion(manifest, rubric, row.caseRevisionId);
        const item: EvalLabelQueuePlanItem = {
          caseRevisionId: row.caseRevisionId,
          trial: row.trial,
          runId: row.runId,
          criterionId: rubricCriterionId(rubric),
          scopeKey: rubricScopeKey(rubric),
          partition: 'validation',
          source: 'random_slice',
          inclusionProbability,
          ...(judgeVersion !== undefined ? { judgeVersion } : {}),
        };
        if (claimed.has(itemKey(item))) continue;
        claimed.add(itemKey(item));
        items.push(item);
      }
    }
  }

  // Read from the deterministic evidence, never from the folded verdict: a
  // judge decides a trial too, so `verdict === 'fail'` no longer implies an
  // instrument found anything. Reading it would file every judge-only failure
  // as a judge AGREEING with a check that never fired.
  const casesWithDeterministicFail = new Set<string>();
  for (const row of trialRows) {
    if (row.disposition !== 'graded') continue;
    if (deterministicOutcome(row, revisionsById.get(row.caseRevisionId)) === 'failed') {
      casesWithDeterministicFail.add(row.caseRevisionId);
    }
  }

  for (const row of trialRows) {
    if (row.disposition !== 'graded') continue;
    const revision = revisionsById.get(row.caseRevisionId);
    if (revision === undefined) continue;
    const results = parseTrialResults(row.resultsJson);
    if (results === null) continue;
    for (const rubricResult of results.rubricResults) {
      if (rubricResult.status !== 'judged' || rubricResult.verdict !== 'fail') continue;
      const item: EvalLabelQueuePlanItem = {
        caseRevisionId: row.caseRevisionId,
        trial: row.trial,
        runId: row.runId,
        criterionId: rubricResult.criterionId,
        scopeKey: rubricResult.scopeKey,
        partition: 'exemplar',
        source: casesWithDeterministicFail.has(row.caseRevisionId)
          ? 'judge_fail'
          : 'judge_disagreement',
        judgeVersion: rubricResult.judgeVersion,
      };
      if (claimed.has(itemKey(item))) continue;
      claimed.add(itemKey(item));
      items.push(item);
    }
  }

  return items;
}

// ============================================================================
// Label materialization — the queue item decides the label's stream fields
// ============================================================================

export interface QueueItemLabelSubject {
  spaceId: string;
  batchId: string;
  caseRevisionId: string;
  trial: number;
  /** Non-null by the submit boundary: an item with no run has nothing to label. */
  runId: string;
  criterionId: string;
  scopeKey: string;
  partition: string;
  judgeVersion: string | null;
}

export interface EvalLabelInsertValues {
  spaceId: string;
  runId: string;
  caseRevisionId: string;
  batchId: string;
  trial: number;
  criterionId: string;
  scopeKey: string;
  verdict: 'pass' | 'fail';
  critique: string;
  judgeVersion: string | null;
  partition: string;
  labeledByUserId: string;
}

/**
 * The D10 partition seam, closed: every stream-determined field of the label
 * (partition above all) comes from the QUEUE ITEM; the caller supplies only
 * the human judgment. No submit path can promote its own label to
 * 'validation'.
 */
export function buildLabelValuesFromQueueItem(
  item: QueueItemLabelSubject,
  submission: { verdict: 'pass' | 'fail'; critique: string; labeledByUserId: string },
): EvalLabelInsertValues {
  return {
    spaceId: item.spaceId,
    runId: item.runId,
    caseRevisionId: item.caseRevisionId,
    batchId: item.batchId,
    trial: item.trial,
    criterionId: item.criterionId,
    scopeKey: item.scopeKey,
    verdict: submission.verdict,
    critique: submission.critique,
    judgeVersion: item.judgeVersion,
    partition: item.partition,
    labeledByUserId: submission.labeledByUserId,
  };
}
