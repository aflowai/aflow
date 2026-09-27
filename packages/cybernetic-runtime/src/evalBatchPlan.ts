/**
 * Pure planning logic for the eval-batch state machine (Plan 269 D17).
 * The durable rows ARE the state machine; everything here is a decision
 * function over row snapshots so claim/ceiling/cancel/terminalize behavior
 * is unit-testable without a database. The worker owns the IO.
 */
import type {
  CaseOutcomeSummary,
  EvalBatchAdvisoryJudgeScore,
  EvalBatchStatus,
  EvalBatchStratumScore,
  EvalBatchSummary,
  EvalCaseResultDisposition,
  TrialOutcomeClass,
  EvalCaseTrialResults,
  EvalCaseTrialVerdict,
} from '@aflow/schemas';
import {
  EvalBatchSummarySchema,
  EvalCaseResultDispositionSchema,
  EvalCaseTrialResultsSchema,
  SKILL_DEFAULT_MAX_CONCURRENT_RUNS,
  summariseCaseOutcome,
} from '@aflow/schemas';

// ============================================================================
// Dispositions
// ============================================================================

const TERMINAL_TRIAL_DISPOSITIONS: ReadonlySet<EvalCaseResultDisposition> = new Set([
  'graded',
  'cancelled',
  'never_started',
]);

export function isTerminalTrialDisposition(disposition: EvalCaseResultDisposition): boolean {
  return TERMINAL_TRIAL_DISPOSITIONS.has(disposition);
}

export type DispositionCounts = Record<EvalCaseResultDisposition, number>;

export function countDispositions(rows: ReadonlyArray<{ disposition: string }>): DispositionCounts {
  const counts: DispositionCounts = {
    scheduled: 0,
    running: 0,
    graded: 0,
    infra_retry: 0,
    cancelled: 0,
    never_started: 0,
  };
  for (const row of rows) {
    const parsed = EvalCaseResultDispositionSchema.safeParse(row.disposition);
    if (parsed.success) counts[parsed.data] += 1;
  }
  return counts;
}

// ============================================================================
// Cost preflight (D17)
// ============================================================================

export interface CostPreflight {
  /** Median of the skill's recent per-run costs; null with no cost history. */
  perRunMedianCents: number | null;
  sampleSize: number;
  /** median × cases × trials; null with no cost history. */
  estimatedCostCents: number | null;
  exceedsCeiling: boolean;
}

/**
 * Derived estimate, not a magic constant: the per-run figure is the median
 * of the skill's own recent production run costs. No history → no estimate;
 * the runtime ceiling still guards the batch.
 */
export function computeCostPreflight(params: {
  recentRunCostsCents: readonly number[];
  caseCount: number;
  trialsPerCase: number;
  costCeilingCents: number;
}): CostPreflight {
  const { recentRunCostsCents, caseCount, trialsPerCase, costCeilingCents } = params;
  const usable = recentRunCostsCents.filter((c) => Number.isFinite(c) && c >= 0);
  if (usable.length === 0) {
    return {
      perRunMedianCents: null,
      sampleSize: 0,
      estimatedCostCents: null,
      exceedsCeiling: false,
    };
  }
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  const estimate = median * caseCount * trialsPerCase;
  return {
    perRunMedianCents: median,
    sampleSize: sorted.length,
    estimatedCostCents: estimate,
    exceedsCeiling: estimate > costCeilingCents,
  };
}

// ============================================================================
// Dispatch cap + claims
// ============================================================================

/**
 * The batch's dispatch cap is the skill's own `SkillConcurrencyPolicy`
 * resolved at launch (D17: batch dispatch honors the skill policy). An
 * undeclared policy caps at 1 — the same default the public start path
 * enforces; 'unlimited' means only the trial count bounds dispatch.
 */
export function resolveBatchDispatchCap(
  declaredMaxConcurrentRuns: number | 'unlimited' | undefined,
  totalTrials: number,
  /**
   * True when any case in the batch grades at the `live` tier. Those trials
   * run in the batch's home space rather than a per-trial fixture space, so
   * running them at once would let one trial's writes reach another's world.
   */
  hasLiveTierCases = false,
): number {
  if (hasLiveTierCases) return 1;
  if (declaredMaxConcurrentRuns === 'unlimited') return totalTrials;
  if (typeof declaredMaxConcurrentRuns === 'number') {
    return Math.max(1, Math.min(declaredMaxConcurrentRuns, totalTrials));
  }
  // A skill that declares nothing gets the concurrency policy's own default
  // rather than serial execution. The public start path also falls back to 1,
  // but that is a collision guard — it stops a skill running against itself
  // unintentionally. A batch is deliberate parallel measurement, and every
  // non-live trial holds its own fixture space, so the guard does not carry.
  return Math.max(1, Math.min(SKILL_DEFAULT_MAX_CONCURRENT_RUNS, totalTrials));
}

export function hasCrossedCostCeiling(costSpentCents: number, costCeilingCents: number): boolean {
  return costSpentCents >= costCeilingCents;
}

/** How many scheduled/infra_retry rows the worker may claim this tick. */
export function planTrialClaims(params: {
  batchStatus: EvalBatchStatus;
  dispatchCap: number;
  runningCount: number;
  claimableCount: number;
  ceilingCrossed: boolean;
}): number {
  const { batchStatus, dispatchCap, runningCount, claimableCount, ceilingCrossed } = params;
  if (batchStatus !== 'running' || ceilingCrossed) return 0;
  return Math.max(0, Math.min(dispatchCap - runningCount, claimableCount));
}

// ============================================================================
// Terminalization (D17)
// ============================================================================

export interface BatchTerminalizationPlan {
  /** True when every trial can reach a terminal disposition NOW. */
  done: boolean;
  finalStatus: 'completed' | 'failed' | 'cancelled';
  /** Pending (scheduled/infra_retry) rows must first be marked never_started. */
  markNeverStarted: boolean;
  terminalReason?: string;
}

/**
 * A batch terminalizes deterministically: normal completion drains every
 * row to `graded`; a crossed ceiling or a cancellation stops claiming, lets
 * in-flight trials finish (ceiling) or cancels them (cancel), and types the
 * rows that never ran. In-flight rows always block terminalization — their
 * verdicts are still arriving.
 */
export function planBatchTerminalization(params: {
  status: EvalBatchStatus;
  counts: DispositionCounts;
  ceilingCrossed: boolean;
  costSpentCents: number;
  costCeilingCents: number;
}): BatchTerminalizationPlan | null {
  const { status, counts, ceilingCrossed, costSpentCents, costCeilingCents } = params;
  if (status !== 'running' && status !== 'cancelling') return null;
  const pending = counts.scheduled + counts.infra_retry;
  const inFlight = counts.running;

  if (status === 'cancelling') {
    return {
      done: inFlight === 0,
      finalStatus: 'cancelled',
      markNeverStarted: pending > 0,
      terminalReason: 'CANCELLED: batch cancellation requested; graded verdicts kept.',
    };
  }

  if (ceilingCrossed) {
    return {
      done: inFlight === 0,
      finalStatus: 'failed',
      markNeverStarted: pending > 0,
      terminalReason:
        `COST_CEILING_EXCEEDED: spent ${String(costSpentCents)}¢ of the ` +
        `${String(costCeilingCents)}¢ ceiling; dispatch halted with ` +
        `${String(pending)} trial(s) never started.`,
    };
  }

  if (pending === 0 && inFlight === 0) {
    return { done: true, finalStatus: 'completed', markNeverStarted: false };
  }
  return null;
}

// ============================================================================
// Scorecard (D5/D6)
// ============================================================================

export interface ScorecardTrialRow {
  caseRevisionId: string;
  trial: number;
  disposition: EvalCaseResultDisposition;
  verdict: EvalCaseTrialVerdict | null;
  /**
   * The stored fold. NULL on rows graded before it existed, which count as
   * evidence that could not be read rather than as a pass or a failure —
   * re-folding `verdict` here would restore the divergence it replaced.
   */
  outcomeClass: TrialOutcomeClass | null;
  resultsJson: unknown;
}

export interface ScorecardStratum {
  scenario: string;
  tier: 'regression' | 'capability';
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Terminal scorecard: per-stratum pass rates, per-case pass^k (all trials
 * graded AND passing) and pass@k (any graded trial passing), the
 * zero-judge-grading share (no pending rubric slots AND no judge calls
 * made), the ADVISORY per-criterion judge section (informs, never gates),
 * and cost. pass^k, never mean-of-trials, is the reliability headline (D5).
 */
export function computeBatchScorecard(params: {
  rows: readonly ScorecardTrialRow[];
  strataByCaseRevision: ReadonlyMap<string, ScorecardStratum>;
  trialsPerCase: number;
  costSpentCents: number;
  terminalReason?: string | undefined;
}): EvalBatchSummary {
  const { rows, strataByCaseRevision, trialsPerCase, costSpentCents, terminalReason } = params;

  const dispositions: Partial<Record<EvalCaseResultDisposition, number>> = {};
  const verdicts: Partial<Record<EvalCaseTrialVerdict, number>> = {};
  let terminalTrials = 0;
  let zeroJudgeTrials = 0;
  let costUnobservedTrials = 0;

  interface AdvisoryJudgeAccumulator {
    criterionId: string;
    scopeKey: string;
    judgeVersions: Set<string>;
    judged: number;
    passed: number;
    errors: number;
    notSelected: number;
    skipped: number;
  }
  // Keyed by (criterionId, scopeKey) — same-named criteria at different
  // scopes are different judges and aggregate separately.
  const advisoryBySlot = new Map<string, AdvisoryJudgeAccumulator>();

  const classesByCase = new Map<string, TrialOutcomeClass[]>();
  for (const row of rows) {
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
    if (!classesByCase.has(row.caseRevisionId)) classesByCase.set(row.caseRevisionId, []);
    if (row.disposition !== 'graded' || row.verdict === null) {
      // A trial that reached a terminal disposition without a verdict — never
      // started, or cancelled mid-flight — produced evidence nobody can read.
      // Leaving it out of the fold entirely made a cancelled batch report
      // three passes with every exclusion counter at zero, which reads as a
      // complete result rather than a truncated one.
      if (isTerminalTrialDisposition(row.disposition)) {
        classesByCase.get(row.caseRevisionId)!.push('incomplete_evidence');
        terminalTrials += 1;
      }
      continue;
    }
    verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
    terminalTrials += 1;
    classesByCase.get(row.caseRevisionId)!.push(row.outcomeClass ?? 'incomplete_evidence');
    const parsed = EvalCaseTrialResultsSchema.safeParse(row.resultsJson);
    const results: EvalCaseTrialResults | null = parsed.success ? parsed.data : null;
    if (results !== null) {
      const judgeCalls = results.rubricResults.filter(
        (r) =>
          r.status === 'judged' ||
          (r.status === 'error' && r.errorCode === 'judge_dispatch_failed'),
      ).length;
      if (results.pendingRubrics.length === 0 && judgeCalls === 0) zeroJudgeTrials += 1;
      if (!results.costObserved) costUnobservedTrials += 1;
      for (const rubricResult of results.rubricResults) {
        const slotKey = `${rubricResult.criterionId} ${rubricResult.scopeKey}`;
        const acc = advisoryBySlot.get(slotKey) ?? {
          criterionId: rubricResult.criterionId,
          scopeKey: rubricResult.scopeKey,
          judgeVersions: new Set<string>(),
          judged: 0,
          passed: 0,
          errors: 0,
          notSelected: 0,
          skipped: 0,
        };
        switch (rubricResult.status) {
          case 'judged':
            acc.judged += 1;
            acc.judgeVersions.add(rubricResult.judgeVersion);
            if (rubricResult.verdict === 'pass') acc.passed += 1;
            break;
          case 'error':
            acc.errors += 1;
            break;
          case 'not_selected':
            acc.notSelected += 1;
            break;
          case 'skipped_run_error':
            acc.skipped += 1;
            break;
        }
        advisoryBySlot.set(slotKey, acc);
      }
    }
  }

  const advisoryJudgeCriteria: EvalBatchAdvisoryJudgeScore[] = [...advisoryBySlot.keys()]
    .sort()
    .map((slotKey) => {
      const acc = advisoryBySlot.get(slotKey)!;
      const [soleVersion] = acc.judgeVersions;
      return {
        criterionId: acc.criterionId,
        scopeKey: acc.scopeKey,
        ...(acc.judgeVersions.size === 1 && soleVersion !== undefined
          ? { judgeVersion: soleVersion }
          : {}),
        judgedTrials: acc.judged,
        passedTrials: acc.passed,
        ...(acc.judged > 0 ? { passShare: rate(acc.passed, acc.judged) } : {}),
        errorTrials: acc.errors,
        notSelectedTrials: acc.notSelected,
        skippedDeterministicFailTrials: acc.skipped,
      };
    });

  const caseIds = [...classesByCase.keys()];
  const byCase = new Map<string, CaseOutcomeSummary>(
    caseIds.map((id) => [id, summariseCaseOutcome(classesByCase.get(id)!, trialsPerCase)]),
  );
  const scoredTrials = [...byCase.values()].reduce((n, c) => n + c.scored, 0);
  const passedTrials = [...byCase.values()].reduce((n, c) => n + c.passed, 0);
  const excludedTrials = [...byCase.values()].reduce(
    (acc, c) => ({
      invalid_case: acc.invalid_case + c.excluded.invalid_case,
      execution_error: acc.execution_error + c.excluded.execution_error,
      incomplete_evidence: acc.incomplete_evidence + c.excluded.incomplete_evidence,
    }),
    { invalid_case: 0, execution_error: 0, incomplete_evidence: 0 },
  );
  // pass^k needs every configured trial scored; pass@k asks only whether the
  // case was ever seen to succeed, so it reads over cases with any scored trial.
  const casesWithVerdicts = caseIds.filter((id) => byCase.get(id)!.scored > 0);
  const completeCases = caseIds.filter((id) => byCase.get(id)!.complete);
  const passAllCases = completeCases.filter((id) => byCase.get(id)!.passAllTrials);
  const passAnyCases = casesWithVerdicts.filter((id) => byCase.get(id)!.passed > 0);

  const strata: EvalBatchStratumScore[] = [];
  const stratumGroups = new Map<string, { stratum: ScorecardStratum; caseIds: string[] }>();
  for (const caseRevisionId of caseIds) {
    const stratum = strataByCaseRevision.get(caseRevisionId);
    if (!stratum) continue;
    const key = `${stratum.tier} ${stratum.scenario}`;
    const group = stratumGroups.get(key) ?? { stratum, caseIds: [] };
    group.caseIds.push(caseRevisionId);
    stratumGroups.set(key, group);
  }
  for (const key of [...stratumGroups.keys()].sort()) {
    const group = stratumGroups.get(key)!;
    let stratumScored = 0;
    let stratumPassed = 0;
    let stratumPassAll = 0;
    let stratumPassAny = 0;
    let stratumCasesWithVerdicts = 0;
    let stratumCompleteCases = 0;
    for (const caseRevisionId of group.caseIds) {
      const entry = byCase.get(caseRevisionId)!;
      stratumScored += entry.scored;
      stratumPassed += entry.passed;
      if (entry.complete) {
        stratumCompleteCases += 1;
        if (entry.passAllTrials) stratumPassAll += 1;
      }
      if (entry.scored === 0) continue;
      stratumCasesWithVerdicts += 1;
      if (entry.passed > 0) stratumPassAny += 1;
    }
    strata.push({
      scenario: group.stratum.scenario,
      tier: group.stratum.tier,
      cases: group.caseIds.length,
      passRate: rate(stratumPassed, stratumScored),
      passAllTrialsRate: rate(stratumPassAll, stratumCompleteCases),
      passAnyTrialRate: rate(stratumPassAny, stratumCasesWithVerdicts),
    });
  }

  return EvalBatchSummarySchema.parse({
    cases: caseIds.length,
    trialsPerCase,
    dispositions,
    verdicts,
    scoredTrials,
    excludedTrials,
    ...(terminalTrials > 0
      ? { executionFailureRate: rate(excludedTrials.execution_error, terminalTrials) }
      : {}),
    ...(scoredTrials > 0
      ? {
          passRate: rate(passedTrials, scoredTrials),
          zeroJudgeShare: rate(zeroJudgeTrials, scoredTrials),
        }
      : {}),
    ...(completeCases.length > 0
      ? { passAllTrialsRate: rate(passAllCases.length, completeCases.length) }
      : {}),
    ...(casesWithVerdicts.length > 0
      ? { passAnyTrialRate: rate(passAnyCases.length, casesWithVerdicts.length) }
      : {}),
    strata,
    advisoryJudgeCriteria,
    costSpentCents,
    costUnobservedTrials,
    ...(terminalReason !== undefined ? { terminalReason } : {}),
  });
}
