/**
 * Shared eval-batch read/view assembly (Plan 269 D12). The Helmsman ops
 * (`eval.batch.get` / `eval.batch.list` / `eval.batch.compare`) and the
 * operator Measurement REST surface narrate the SAME durable state — this
 * module is the single assembly of head views, case-result views, the
 * paired baseline comparison, and the graduation flag, so the two surfaces
 * can never drift apart.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EvalBatchRow } from '@aflow/database';
import {
  DirectiveLearningPolicySchema,
  EvalBatchGetOutputSchema,
  EvalBatchProvenanceManifestSchema,
  deriveCaseCoverage,
  EvalBatchSummarySchema,
  EvalCaseTrialResultsSchema,
  EvalTrialDetailViewSchema,
  type EvalBatchBaselineDelta,
  type EvalBatchCaseResultView,
  type EvalBatchComparison,
  type EvalBatchCompareInput,
  type EvalBatchCompareSide,
  type EvalBatchGetOutput,
  type EvalBatchHeadView,
  type EvalGraduationCandidate,
  type EvalTrialDetailView,
  type TenantId,
} from '@aflow/schemas';
import {
  compareEvalBatches,
  deriveGraduationCandidates,
  type CompareCaseMeta,
  type CompareTrialRow,
  type GraduationBatchSnapshot,
} from './evalBatchCompare.js';
import {
  getEvalBaseline,
  getEvalBatchHead,
  getGoldenCaseRevisionsByIds,
  listEvalBatchMemberRevisionIds,
  listEvalBatches,
  getTrialRow,
  listTrialRows,
  loadTrialRunSnapshot,
} from './evalBatchStore.js';
import { replyTextFrom } from './evalTrialGrader.js';
import { buildJudgeScorecardsForBatch } from './judgeScorecardBuild.js';
import { loadSpaceDirectives } from './modelResolution.js';

export const TERMINAL_BATCH_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Upper bound on batches scanned for the graduation streak (mirrors the scorecard scan bound). */
const GRADUATION_BATCH_SCAN_LIMIT = 100;

export function toEvalBatchHeadView(row: EvalBatchRow & { caseCount: number }): EvalBatchHeadView {
  return {
    batchId: row.id,
    workflowSlug: row.workflowSlug,
    workflowRevision: row.workflowRevision,
    datasetId: row.datasetId,
    datasetVersion: row.datasetVersion,
    status: row.status as EvalBatchHeadView['status'],
    trialsPerCase: row.trialsPerCase,
    caseCount: row.caseCount,
    costCeilingCents: row.costCeilingCents,
    costSpentCents: row.costSpentCents,
    ...(row.notes !== null ? { notes: row.notes } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt !== null ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt.toISOString() } : {}),
  };
}

function toCompareSide(row: EvalBatchRow): EvalBatchCompareSide {
  // A manifest that will not parse is absent rather than partial: comparison
  // reports an unrecorded dimension as unknown, and half a manifest would let
  // some dimensions read as unchanged on no evidence.
  const manifest = EvalBatchProvenanceManifestSchema.safeParse(row.provenanceManifestJson);
  return {
    batchId: row.id,
    datasetVersion: row.datasetVersion,
    workflowRevision: row.workflowRevision,
    trialsPerCase: row.trialsPerCase,
    status: row.status as EvalBatchCompareSide['status'],
    ...(manifest.success ? { manifest: manifest.data } : {}),
  };
}

function toCompareTrialRow(row: {
  caseRevisionId: string;
  trial: number;
  disposition: string;
  verdict: string | null;
  outcomeClass: string | null;
  runId: string | null;
}): CompareTrialRow {
  return {
    caseRevisionId: row.caseRevisionId,
    trial: row.trial,
    disposition: row.disposition,
    verdict: row.verdict,
    outcomeClass: row.outcomeClass,
    runId: row.runId,
  };
}

async function loadCompareCaseMeta(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  revisionIds: readonly string[],
): Promise<Map<string, CompareCaseMeta>> {
  const revisions = await getGoldenCaseRevisionsByIds(db, tenantId, revisionIds);
  return new Map(
    [...revisions].map(([revisionId, revision]) => [
      revisionId,
      {
        caseId: revision.caseId,
        title: revision.case.title,
        scenario: revision.case.stratum.scenario,
        tier: revision.case.stratum.tier,
      },
    ]),
  );
}

export async function buildComparisonForBatches(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  headA: EvalBatchRow,
  headB: EvalBatchRow,
): Promise<EvalBatchComparison> {
  const [membersA, membersB, rowsA, rowsB] = await Promise.all([
    listEvalBatchMemberRevisionIds(db, tenantId, headA.id),
    listEvalBatchMemberRevisionIds(db, tenantId, headB.id),
    listTrialRows(db, tenantId, headA.id),
    listTrialRows(db, tenantId, headB.id),
  ]);
  const caseMetaByRevisionId = await loadCompareCaseMeta(db, tenantId, [
    ...new Set([...membersA, ...membersB]),
  ]);
  return compareEvalBatches({
    batchA: toCompareSide(headA),
    batchB: toCompareSide(headB),
    memberRevisionIdsA: membersA,
    memberRevisionIdsB: membersB,
    trialRowsA: rowsA.map(toCompareTrialRow),
    trialRowsB: rowsB.map(toCompareTrialRow),
    caseMetaByRevisionId,
  });
}

function resolveGraduationConsecutiveBatches(learningPolicy: unknown): number {
  const knobSchema = DirectiveLearningPolicySchema.shape.graduationConsecutiveBatches;
  const parsed = knobSchema.safeParse(
    (learningPolicy as { graduationConsecutiveBatches?: unknown } | undefined | null)
      ?.graduationConsecutiveBatches,
  );
  return parsed.success ? parsed.data : knobSchema.parse(undefined);
}

export async function computeGraduationCandidates(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  workflowSlug: string,
): Promise<EvalGraduationCandidate[]> {
  const directives = await loadSpaceDirectives(db, tenantId as string, spaceId);
  const graduationConsecutiveBatches = resolveGraduationConsecutiveBatches(
    directives?.learningPolicy,
  );
  const heads = await listEvalBatches(db, tenantId, {
    spaceId,
    workflowSlug,
    limit: GRADUATION_BATCH_SCAN_LIMIT,
  });
  const completed = heads
    .filter((head) => head.status === 'completed')
    .slice(0, graduationConsecutiveBatches);
  if (completed.length < graduationConsecutiveBatches) return [];

  const snapshots: GraduationBatchSnapshot[] = [];
  for (const head of completed) {
    const rows = await listTrialRows(db, tenantId, head.id);
    snapshots.push({
      batchId: head.id,
      trialsPerCase: head.trialsPerCase,
      trialRows: rows.map(toCompareTrialRow),
    });
  }
  const revisionIds = [
    ...new Set(snapshots.flatMap((s) => s.trialRows.map((r) => r.caseRevisionId))),
  ];
  const caseMetaByRevisionId = await loadCompareCaseMeta(db, tenantId, revisionIds);
  return deriveGraduationCandidates({
    completedBatchesNewestFirst: snapshots,
    caseMetaByRevisionId,
    graduationConsecutiveBatches,
  });
}

export function toBaselineDelta(comparison: EvalBatchComparison): EvalBatchBaselineDelta {
  return {
    baselineBatchId: comparison.batchA.batchId,
    pairedCases: comparison.pairedCases,
    ...(comparison.perCaseSuccess !== undefined
      ? { perCaseSuccess: comparison.perCaseSuccess }
      : {}),
    ...(comparison.trialPass !== undefined ? { trialPass: comparison.trialPass } : {}),
    passToFailFlips: comparison.flips.filter((f) => f.direction === 'pass_to_fail').length,
    failToPassFlips: comparison.flips.filter((f) => f.direction === 'fail_to_pass').length,
    investigationFlips: comparison.flips.filter((f) => f.finding === 'investigation').length,
    uncertaintyNote: comparison.uncertaintyNote,
  };
}

// ============================================================================
// eval.batch.get / eval.batch.list assembly
// ============================================================================

export async function buildEvalBatchDetail(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  scope: { spaceId: string; batchId: string },
): Promise<EvalBatchGetOutput | null> {
  const head = await getEvalBatchHead(db, tenantId, scope);
  if (!head) return null;

  const trialRows = await listTrialRows(db, tenantId, head.id);
  const revisions = await getGoldenCaseRevisionsByIds(db, tenantId, [
    ...new Set(trialRows.map((r) => r.caseRevisionId)),
  ]);

  const caseResults: EvalBatchCaseResultView[] = trialRows.map((row) => {
    const results =
      row.resultsJson !== null && typeof row.resultsJson === 'object'
        ? (row.resultsJson as { fractionPassed?: number; gradingError?: string })
        : undefined;
    const revision = revisions.get(row.caseRevisionId);
    const title = revision?.case.title;
    const stratum = revision?.case.stratum;
    // Carried on the result rather than left to the case editor: a coverage
    // gap that only shows where cases are authored is one nobody reads while
    // looking at a green batch.
    const uncoveredRequirements =
      revision !== undefined
        ? deriveCaseCoverage({
            requirements: revision.case.requirements,
            expectations: revision.case.expectations,
            rubrics: revision.case.rubrics,
          }).uncovered
        : [];
    return {
      caseRevisionId: row.caseRevisionId,
      ...(title !== undefined ? { caseTitle: title } : {}),
      ...(stratum?.scenario !== undefined ? { scenario: stratum.scenario } : {}),
      ...(stratum?.tier !== undefined ? { tier: stratum.tier } : {}),
      trial: row.trial,
      disposition: row.disposition as EvalBatchCaseResultView['disposition'],
      ...(row.verdict !== null
        ? { verdict: row.verdict as NonNullable<EvalBatchCaseResultView['verdict']> }
        : {}),
      ...(row.outcomeClass !== null
        ? { outcomeClass: row.outcomeClass as NonNullable<EvalBatchCaseResultView['outcomeClass']> }
        : {}),
      ...(row.aggregationVersion !== null ? { aggregationVersion: row.aggregationVersion } : {}),
      ...(uncoveredRequirements.length > 0 ? { uncoveredRequirements } : {}),
      ...(row.runId !== null ? { runId: row.runId } : {}),
      ...(typeof results?.fractionPassed === 'number'
        ? { fractionPassed: results.fractionPassed }
        : {}),
      ...(row.costCents !== null ? { costCents: row.costCents } : {}),
      ...(typeof results?.gradingError === 'string' ? { gradingError: results.gradingError } : {}),
    };
  });

  const summaryParse = EvalBatchSummarySchema.safeParse(head.summaryJson);
  const judgeScorecards = await buildJudgeScorecardsForBatch(db, tenantId, {
    spaceId: scope.spaceId,
    batchId: head.id,
  });

  // D12 folding: the pinned baseline, the compact vs-baseline delta (both
  // sides terminal), and the capability-graduation flag.
  const baselineRow = await getEvalBaseline(db, tenantId, {
    spaceId: scope.spaceId,
    workflowSlug: head.workflowSlug,
  });
  let baselineDelta: EvalBatchBaselineDelta | undefined;
  if (
    baselineRow !== null &&
    baselineRow.batchId !== head.id &&
    TERMINAL_BATCH_STATUSES.has(head.status)
  ) {
    const baselineHead = await getEvalBatchHead(db, tenantId, {
      spaceId: scope.spaceId,
      batchId: baselineRow.batchId,
    });
    if (baselineHead !== null && TERMINAL_BATCH_STATUSES.has(baselineHead.status)) {
      baselineDelta = toBaselineDelta(
        await buildComparisonForBatches(db, tenantId, baselineHead, head),
      );
    }
  }
  const graduationCandidates = await computeGraduationCandidates(
    db,
    tenantId,
    scope.spaceId,
    head.workflowSlug,
  );

  return EvalBatchGetOutputSchema.parse({
    batch: toEvalBatchHeadView({ ...head, caseCount: revisions.size }),
    provenanceManifest: EvalBatchProvenanceManifestSchema.parse(head.provenanceManifestJson),
    ...(summaryParse.success ? { summary: summaryParse.data } : {}),
    caseResults,
    ...(judgeScorecards.length > 0 ? { judgeScorecards } : {}),
    ...(baselineRow !== null
      ? {
          baseline: {
            batchId: baselineRow.batchId,
            pinnedAt: baselineRow.pinnedAt.toISOString(),
          },
          isBaseline: baselineRow.batchId === head.id,
        }
      : {}),
    ...(baselineDelta !== undefined ? { baselineDelta } : {}),
    ...(graduationCandidates.length > 0 ? { graduationCandidates } : {}),
  });
}

/**
 * One trial's attribution view: which checks fired, what the judges said, the
 * endpoints the run reached, and what it replied.
 *
 * Scoped to a single trial on purpose — a batch-wide version of this read grows
 * with cases × trials and is unbounded, and attribution is a one-trial act.
 *
 * `retrievePayload` is optional and its absence is reported rather than
 * hidden: `reply` is omitted and `replyRef` is returned, so a caller without a
 * payload store cannot mistake an unfetched answer for an empty one.
 */
export async function buildEvalTrialDetail(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  scope: { spaceId: string; batchId: string; caseRevisionId: string; trial: number },
  options?: { retrievePayload?: (ref: string) => Promise<unknown> },
): Promise<EvalTrialDetailView | null> {
  const head = await getEvalBatchHead(db, tenantId, {
    spaceId: scope.spaceId,
    batchId: scope.batchId,
  });
  if (!head) return null;

  const row = await getTrialRow(db, tenantId, {
    batchId: head.id,
    caseRevisionId: scope.caseRevisionId,
    trial: scope.trial,
  });
  if (!row) return null;

  const revisions = await getGoldenCaseRevisionsByIds(db, tenantId, [row.caseRevisionId]);
  const title = revisions.get(row.caseRevisionId)?.case.title;

  // A row mid-flight has no results yet, and a row whose grader errored may
  // hold a partial object. Neither is a reason to refuse the view — the
  // trajectory and the reply are often exactly what explains them.
  const results = EvalCaseTrialResultsSchema.safeParse(row.resultsJson);

  let trajectory: EvalTrialDetailView['trajectory'] = [];
  let runStatus: EvalTrialDetailView['runStatus'];
  let reply: string | undefined;
  let replyRef: string | undefined;

  if (row.runId !== null) {
    const snapshot = await loadTrialRunSnapshot(db, tenantId, row.runId);
    if (snapshot) {
      runStatus = snapshot.run.status as EvalTrialDetailView['runStatus'];
      trajectory = snapshot.simulationCalls.map((call, index) => ({
        sequence: index,
        simulationId: call.simulationId,
        endpointId: call.endpointId,
        responseStatus: call.responseStatus,
        mutated: call.deltaRef !== null,
      }));
      const ref = snapshot.run.pausedPayloadRef;
      if (typeof ref === 'string' && ref.length > 0) {
        replyRef = ref;
        if (options?.retrievePayload) {
          try {
            reply = replyTextFrom(await options.retrievePayload(ref));
          } catch {
            // The ref is reported either way; a fetch failure must not cost
            // the caller the trajectory it came for.
          }
        }
      }
    }
  }

  return EvalTrialDetailViewSchema.parse({
    batchId: head.id,
    caseRevisionId: row.caseRevisionId,
    ...(title !== undefined ? { caseTitle: title } : {}),
    trial: row.trial,
    disposition: row.disposition,
    ...(row.verdict !== null ? { verdict: row.verdict } : {}),
    ...(row.runId !== null ? { runId: row.runId } : {}),
    ...(runStatus !== undefined ? { runStatus } : {}),
    resultsReadable: results.success,
    ...(results.success
      ? {
          ...(results.data.fractionPassed !== undefined
            ? { fractionPassed: results.data.fractionPassed }
            : {}),
          expectationResults: results.data.expectationResults,
          rubricResults: results.data.rubricResults,
          pendingRubrics: results.data.pendingRubrics,
          ...(results.data.gradingError !== undefined
            ? { gradingError: results.data.gradingError }
            : {}),
        }
      : {}),
    trajectory,
    ...(reply !== undefined ? { reply } : {}),
    ...(replyRef !== undefined ? { replyRef } : {}),
  });
}

export async function buildEvalBatchList(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug?: string | undefined; limit: number },
): Promise<EvalBatchHeadView[]> {
  const rows = await listEvalBatches(db, tenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    limit: params.limit,
  });
  const batches: EvalBatchHeadView[] = [];
  for (const row of rows) {
    const trialRows = await listTrialRows(db, tenantId, row.id);
    const caseCount = new Set(trialRows.map((r) => r.caseRevisionId)).size;
    batches.push(toEvalBatchHeadView({ ...row, caseCount }));
  }
  return batches;
}

// ============================================================================
// eval.batch.compare resolution — shared refusal-first head resolution
// ============================================================================

export type EvalBatchCompareRefusalCode =
  | 'EVAL_BATCH_NOT_FOUND'
  | 'EVAL_BASELINE_NOT_PINNED'
  | 'EVAL_BATCH_IS_BASELINE'
  | 'EVAL_BASELINE_BATCH_MISSING'
  | 'EVAL_BATCH_COMPARE_DIFFERENT_SKILLS'
  | 'EVAL_BATCH_NOT_TERMINAL';

export type EvalBatchCompareResolution =
  | {
      ok: true;
      comparison: EvalBatchComparison;
      baselineBatchId?: string;
      graduationCandidates: EvalGraduationCandidate[];
    }
  | { ok: false; code: EvalBatchCompareRefusalCode; message: string };

export async function resolveEvalBatchComparison(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  input: EvalBatchCompareInput,
): Promise<EvalBatchCompareResolution> {
  const loadHead = async (batchId: string): Promise<EvalBatchRow | null> =>
    getEvalBatchHead(db, tenantId, { spaceId, batchId });
  const notFound = (batchId: string): EvalBatchCompareResolution => ({
    ok: false,
    code: 'EVAL_BATCH_NOT_FOUND',
    message: `No eval batch '${batchId}' exists in this space. Discover batches with eval.batch.list.`,
  });

  let headA: EvalBatchRow | null;
  let headB: EvalBatchRow | null;
  let baselineBatchId: string | undefined;
  if (input.against === 'baseline') {
    headB = await loadHead(input.batchId!);
    if (!headB) return notFound(input.batchId!);
    const baselineRow = await getEvalBaseline(db, tenantId, {
      spaceId,
      workflowSlug: headB.workflowSlug,
    });
    if (baselineRow === null) {
      return {
        ok: false,
        code: 'EVAL_BASELINE_NOT_PINNED',
        message:
          `No baseline is pinned for skill '${headB.workflowSlug}' — pinning is an operator action ` +
          'on the Measurement surface. Compare two batches explicitly, or ask the operator to pin one.',
      };
    }
    if (baselineRow.batchId === headB.id) {
      return {
        ok: false,
        code: 'EVAL_BATCH_IS_BASELINE',
        message:
          'This batch IS the pinned baseline — comparing it against itself measures nothing. ' +
          'Compare two batches explicitly.',
      };
    }
    headA = await loadHead(baselineRow.batchId);
    if (!headA) {
      return {
        ok: false,
        code: 'EVAL_BASELINE_BATCH_MISSING',
        message: `The pinned baseline batch '${baselineRow.batchId}' no longer exists — ask the operator to repin.`,
      };
    }
    baselineBatchId = baselineRow.batchId;
  } else {
    [headA, headB] = await Promise.all([loadHead(input.batchIdA!), loadHead(input.batchIdB!)]);
    if (headA === null) return notFound(input.batchIdA!);
    if (headB === null) return notFound(input.batchIdB!);
  }

  if (headA.workflowSlug !== headB.workflowSlug) {
    return {
      ok: false,
      code: 'EVAL_BATCH_COMPARE_DIFFERENT_SKILLS',
      message:
        `Batches measure different skills ('${headA.workflowSlug}' vs '${headB.workflowSlug}') — ` +
        'a paired comparison tracks one skill across time.',
    };
  }
  const nonTerminal = [headA, headB].find((h) => !TERMINAL_BATCH_STATUSES.has(h.status));
  if (nonTerminal !== undefined) {
    return {
      ok: false,
      code: 'EVAL_BATCH_NOT_TERMINAL',
      message:
        `Batch '${nonTerminal.id}' is '${nonTerminal.status}' — verdicts are still arriving. ` +
        'Compare terminal batches.',
    };
  }

  const comparison = await buildComparisonForBatches(db, tenantId, headA, headB);
  const graduationCandidates = await computeGraduationCandidates(
    db,
    tenantId,
    spaceId,
    headA.workflowSlug,
  );
  return {
    ok: true,
    comparison,
    ...(baselineBatchId !== undefined ? { baselineBatchId } : {}),
    graduationCandidates,
  };
}
