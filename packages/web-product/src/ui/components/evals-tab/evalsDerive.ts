/**
 * Pure client-side derivations for the Evals tab (Plan 269 Part 6).
 * Stratum grouping and coverage gaps derive from the loaded case set —
 * never a hand-maintained taxonomy — so the tab stays honest about what
 * the dataset actually contains.
 */
import type { LabelQueueItem } from './evalsApi.js';
import type {
  CaseExpectation,
  EvalBatchBaselineDelta,
  EvalBatchCaseResultView,
  EvalBatchDelta,
  EvalCaseRubricResult,
  EvalLabelQueueEvidence,
  EvalLabelQueueRubric,
  EvalRubricJudgeErrorCode,
  EvalTrialCallView,
  GoldenCaseContent,
  EvalTrialDetailView,
  ExpectationResult,
  GoldenCaseDirection,
  GoldenCaseRevision,
  GoldenCaseTier,
  JudgeRubricEntry,
  TrialOutcomeClass,
} from '@aflow/schemas';
import { summariseCaseOutcome } from '@aflow/schemas';

export interface ScenarioGroup {
  scenario: string;
  cases: GoldenCaseRevision[];
}

/** Active cases grouped by stratum scenario, scenarios alphabetical, cases by title. */
export function groupCasesByScenario(cases: readonly GoldenCaseRevision[]): ScenarioGroup[] {
  const byScenario = new Map<string, GoldenCaseRevision[]>();
  for (const revision of cases) {
    const scenario = revision.case.stratum.scenario;
    const bucket = byScenario.get(scenario);
    if (bucket) bucket.push(revision);
    else byScenario.set(scenario, [revision]);
  }
  return [...byScenario.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scenario, group]) => ({
      scenario,
      cases: [...group].sort((a, b) => a.case.title.localeCompare(b.case.title)),
    }));
}

export interface CoverageGap {
  scenario: string;
  tier: GoldenCaseTier;
  direction: GoldenCaseDirection;
}

export interface CoverageView {
  gaps: CoverageGap[];
  /**
   * Scenarios carrying a single case. Nothing can be said about their
   * coverage, and saying it anyway is what made this surface unreadable.
   */
  singletonScenarios: number;
}

/**
 * Strata with zero cases: every scenario the dataset uses as a BUCKET, against
 * every (tier, direction) combination observed anywhere in it. A cell empty for
 * one bucket while occupied for another is a hole in the instrument, reported,
 * never enforced.
 *
 * A scenario is only a bucket once more than one case shares it. `scenario` is
 * free text, so an author can put a whole sentence there — a description of one
 * case rather than a taxonomy cell — and the cross-product then invents a gap
 * for every direction that single case does not take. On a real dataset that
 * was eleven warnings, all of them describing the naming rather than the
 * coverage, and the one true gap sat among them unreadable. The dataset never
 * claimed a lone scenario should span directions; only a shared one does.
 */
export function deriveCoverage(cases: readonly GoldenCaseRevision[]): CoverageView {
  const caseCount = new Map<string, number>();
  const combos = new Map<string, { tier: GoldenCaseTier; direction: GoldenCaseDirection }>();
  const occupied = new Set<string>();
  for (const revision of cases) {
    const { scenario, tier, direction } = revision.case.stratum;
    caseCount.set(scenario, (caseCount.get(scenario) ?? 0) + 1);
    combos.set(`${tier}|${direction}`, { tier, direction });
    occupied.add(`${scenario}|${tier}|${direction}`);
  }
  const buckets = [...caseCount.entries()]
    .filter(([, count]) => count > 1)
    .map(([scenario]) => scenario)
    .sort((a, b) => a.localeCompare(b));
  const gaps: CoverageGap[] = [];
  for (const scenario of buckets) {
    for (const [comboKey, combo] of [...combos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!occupied.has(`${scenario}|${comboKey}`)) {
        gaps.push({ scenario, tier: combo.tier, direction: combo.direction });
      }
    }
  }
  return { gaps, singletonScenarios: caseCount.size - buckets.length };
}

// ============================================================================
// Formatting — every rate/delta renders with its honesty attached
// ============================================================================

export function formatCents(cents: number): string {
  return cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${String(cents)}¢`;
}

export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatSignedPp(value: number): string {
  const pp = (value * 100).toFixed(1);
  return value >= 0 ? `+${pp}pp` : `${pp}pp`;
}

/** "62.0% → 71.0% (Δ +9.0pp, 95% CI [+1.2pp, +16.8pp])" — a delta never renders bare (D12). */
export function formatDeltaWithInterval(delta: EvalBatchDelta): string {
  return (
    `${formatPct(delta.rateA)} → ${formatPct(delta.rateB)} ` +
    `(Δ ${formatSignedPp(delta.delta)}, 95% CI [${formatSignedPp(delta.intervalLower)}, ${formatSignedPp(delta.intervalUpper)}])`
  );
}

/** The interval as evidence: does it exclude zero (a finding) or straddle it (noise)? */
export function intervalExcludesZero(delta: EvalBatchDelta): boolean {
  return delta.intervalLower > 0 || delta.intervalUpper < 0;
}

/** "Δ +9.0pp (95% CI +1.2pp, +16.8pp)" — the collapsed-header form, still never bare. */
export function formatDeltaCompact(delta: EvalBatchDelta): string {
  return (
    `Δ ${formatSignedPp(delta.delta)} ` +
    `(95% CI ${formatSignedPp(delta.intervalLower)}, ${formatSignedPp(delta.intervalUpper)})`
  );
}

export function countFailingTrials(results: readonly EvalBatchCaseResultView[]): number {
  return results.filter((result) => result.verdict === 'fail').length;
}

/**
 * The trial rows' own headline, read while they are collapsed. A running
 * batch says "recorded so far" — a partial count that reads as a result is
 * worse than no count.
 */
export function formatTrialsSubtitle(
  results: readonly EvalBatchCaseResultView[],
  live: boolean,
): string {
  if (results.length === 0) return live ? 'no trial rows yet' : 'no trial rows';
  const failing = countFailingTrials(results);
  const rows = `${String(results.length)} trial row${results.length === 1 ? '' : 's'}`;
  const failingPart = failing > 0 ? `${String(failing)} failing` : 'none failing';
  return `${rows}${live ? ' recorded so far' : ''} · ${failingPart}`;
}

function formatFlipCount(delta: EvalBatchBaselineDelta): string {
  const flips = delta.passToFailFlips + delta.failToPassFlips;
  if (flips === 0) return 'no flips';
  return `${String(flips)} flip${flips === 1 ? '' : 's'}`;
}

/**
 * Did it regress — read from the batch's own folded delta, so the collapsed
 * header states its headline synchronously with the batch read rather than
 * changing once the paired comparison lands.
 */
export function formatComparisonSubtitle(input: {
  terminal: boolean;
  isBaseline: boolean;
  baselinePinned: boolean;
  delta: EvalBatchBaselineDelta | undefined;
}): string {
  if (!input.terminal) return 'reads once the batch is terminal';
  if (input.isBaseline) return 'this batch is the pinned ruler';
  if (!input.baselinePinned) return 'no baseline pinned';
  const delta = input.delta;
  if (delta === undefined) return 'no paired comparison yet';
  const flips = formatFlipCount(delta);
  if (delta.perCaseSuccess === undefined) {
    return `n=${String(delta.pairedCases)} paired cases · ${flips}`;
  }
  return `pass^k ${formatDeltaCompact(delta.perCaseSuccess)} · ${flips}`;
}

// ============================================================================
// Label queue — the question and the material a verdict is worth anything from
// ============================================================================

export interface RubricQuestionView {
  /** Criterion name when it resolved, else the bare id the item carries. */
  title: string;
  entries: JudgeRubricEntry[];
  referenceAnswer: string | null;
  /** Why there are no entries to read — never left implicit. */
  note: string | null;
  /** The entries resolved but may not be the ones the judge was given. */
  warning: string | null;
}

export function deriveRubricQuestionView(item: {
  criterionId: string;
  rubric?: EvalLabelQueueRubric | undefined;
}): RubricQuestionView {
  const rubric = item.rubric;
  if (rubric === undefined) {
    return {
      title: item.criterionId,
      entries: [],
      referenceAnswer: null,
      note: 'The rubric was not included with this item, so what PASS means here is not stated.',
      warning: null,
    };
  }
  return {
    title: rubric.name ?? rubric.criterionId,
    entries: [...rubric.entries],
    referenceAnswer: rubric.referenceAnswer ?? null,
    note:
      rubric.entries.length > 0
        ? null
        : (rubric.unresolved ?? 'The rubric for this criterion could not be resolved.'),
    warning: rubric.judgeVersionDrift ?? null,
  };
}

/**
 * Which producer wrote a block — the renderer's discriminator. Never the
 * label: that is display copy and would rot the moment it is reworded.
 */
export type JudgeEvidenceSource = 'reference_output' | 'task_summaries' | 'task_output';

export interface JudgeEvidenceBlock {
  label: string;
  content: string;
  source: JudgeEvidenceSource;
}

export interface JudgeEvidenceView {
  blocks: JudgeEvidenceBlock[];
  /** Why there is nothing to read — an empty panel would read as "the run produced nothing". */
  note: string | null;
  /** The blocks below are NARROWER than the judge's pack, not a full replay. */
  warning: string | null;
}

function formatTaskSummaries(
  summaries: ReadonlyArray<{ taskId: string; status: string; summary?: string | undefined }>,
): string {
  return summaries
    .map(
      (task) =>
        `${task.taskId} [${task.status.toUpperCase()}]${task.summary ? `: ${task.summary}` : ''}`,
    )
    .join('\n');
}

/**
 * The judge's evidence as labelled blocks, ordered as the judge's own prompt
 * orders it (reference output, run artifacts, task outputs) so the human
 * reads the same material in the same order — the scorecard only measures
 * the judge if both sides judged the same thing.
 */
export function deriveJudgeEvidenceView(
  evidence: EvalLabelQueueEvidence | undefined,
): JudgeEvidenceView {
  if (evidence === undefined) {
    return {
      blocks: [],
      note: 'The judge’s evidence was not included with this item.',
      warning: null,
    };
  }
  if (evidence.status === 'unavailable') {
    return { blocks: [], note: evidence.detail, warning: null };
  }

  const blocks: JudgeEvidenceBlock[] = [];
  if (evidence.referenceOutput !== undefined) {
    blocks.push({
      label: 'Reference output (guidance — similarity is never scored)',
      content: evidence.referenceOutput,
      source: 'reference_output',
    });
  }
  if (evidence.taskSummaries.length > 0) {
    blocks.push({
      label: 'Run artifacts',
      content: formatTaskSummaries(evidence.taskSummaries),
      source: 'task_summaries',
    });
  }
  for (const output of evidence.taskOutputs) {
    blocks.push({
      label: `Task output — ${output.taskId}`,
      content: output.content,
      source: 'task_output',
    });
  }
  const unresolved = evidence.unresolvedArtifacts;
  return {
    blocks,
    note:
      blocks.length > 0
        ? null
        : 'The judge received no task outputs and no task summaries for this trial.',
    warning:
      unresolved > 0
        ? `${String(unresolved)} artifact${unresolved === 1 ? '' : 's'} the judge’s evidence referenced ` +
          'could not be retrieved, so this pack is narrower than the judge’s. Discard rather than ' +
          'mark if the material below cannot answer the criterion.'
        : null,
  };
}

/**
 * How one evidence block renders. `text` carries WHY it stayed text so the
 * reason is testable rather than inferred from the absence of a tree.
 */
export type EvidenceRender =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; reason: 'summaries' | 'empty' | 'not_structured' | 'unparsed' };

/**
 * A block is JSON only when its producer can emit JSON and the text is a
 * parseable object or array. Three producers feed one renderer: task
 * summaries are line-oriented by construction, and the other two pass a
 * string payload through untouched — so prose and stringified scalars are
 * ruled out by their first character before the parser sees them. Truncated
 * JSON (the evidence binder appends its own marker past the cap) fails to
 * parse and falls back to the wrapped text, marker intact.
 */
export function deriveEvidenceRender(block: JudgeEvidenceBlock): EvidenceRender {
  if (block.source === 'task_summaries') return { kind: 'text', reason: 'summaries' };
  const trimmed = block.content.trim();
  if (trimmed === '') return { kind: 'text', reason: 'empty' };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { kind: 'text', reason: 'not_structured' };
  }
  try {
    return { kind: 'json', value: JSON.parse(trimmed) };
  } catch {
    return { kind: 'text', reason: 'unparsed' };
  }
}

// ============================================================================
// Per-trial attribution — which of the three exits a failure belongs to
// ============================================================================

export const EXPECTATION_KIND_LABEL: Record<ExpectationResult['kind'], string> = {
  terminal: 'terminal',
  task_status: 'task status',
  output: 'output',
  reply: 'reply',
  trajectory: 'trajectory',
  simulation: 'simulation',
};

export type TrialExit = 'contract' | 'instruction' | 'expectation';

/** Which exit a check speaks to: what the run reached, or what the run answered. */
export const EXPECTATION_EXIT: Record<ExpectationResult['kind'], 'contract' | 'instruction'> = {
  trajectory: 'contract',
  simulation: 'contract',
  terminal: 'instruction',
  task_status: 'instruction',
  output: 'instruction',
  reply: 'instruction',
};

export const JUDGE_ERROR_SENTENCE: Record<EvalRubricJudgeErrorCode, string> = {
  judge_model_equals_subject:
    "The judge model resolved to the subject's own model, so the judge was refused rather than allowed to grade itself.",
  judge_dispatch_failed: 'The judge call failed — provider, parse, or timeout.',
  judge_client_unavailable: "No credential resolves for the judge model's provider.",
  rubric_criterion_unresolved: 'The rubric names a criterion the production suite does not carry.',
  manifest_unavailable:
    'The manifest would not parse, so judge-is-not-subject could not be checked. The judge was refused.',
  evidence_unavailable:
    'This trial carried none of the evidence the criterion reads, so the judge was not asked. A judge shown nothing about a fact reads its absence as an invention, and the verdict would say more about the pack than about the answer.',
};

export interface TrialCheckGroup {
  failing: ExpectationResult[];
  passing: ExpectationResult[];
  total: number;
}

export interface TrialChecks {
  contract: TrialCheckGroup;
  instruction: TrialCheckGroup;
  passedCount: number;
  total: number;
  /** Set when `fractionPassed` disagrees with the listed checks by more than half a point. */
  fractionMismatch: string | null;
}

/** Checks partitioned by the exit they speak to; array order is the authored order. */
export function deriveTrialChecks(detail: EvalTrialDetailView): TrialChecks {
  const contract: TrialCheckGroup = { failing: [], passing: [], total: 0 };
  const instruction: TrialCheckGroup = { failing: [], passing: [], total: 0 };
  for (const result of detail.expectationResults) {
    const group = EXPECTATION_EXIT[result.kind] === 'contract' ? contract : instruction;
    group.total += 1;
    if (result.passed) group.passing.push(result);
    else group.failing.push(result);
  }
  const total = contract.total + instruction.total;
  const passedCount = contract.passing.length + instruction.passing.length;
  const recorded = detail.fractionPassed;
  const fractionMismatch =
    total > 0 && recorded !== undefined && Math.abs(recorded - passedCount / total) > 0.005
      ? `The recorded pass fraction (${formatPct(recorded)}) does not match the checks listed (${formatPct(passedCount / total)}).`
      : null;
  return { contract, instruction, passedCount, total, fractionMismatch };
}

export interface TrialTrajectoryFacts {
  calls: number;
  mutating: number;
  refused: number;
  firstRefused: EvalTrialCallView | null;
  multiSimulation: boolean;
  soleSimulationId: string | null;
}

/** Trajectory facts read in array order — the journal order the run actually took. */
export function deriveTrialTrajectoryFacts(detail: EvalTrialDetailView): TrialTrajectoryFacts {
  let mutating = 0;
  let refused = 0;
  let firstRefused: EvalTrialCallView | null = null;
  const simulations = new Set<string>();
  for (const call of detail.trajectory) {
    if (call.mutated) mutating += 1;
    if (call.responseStatus >= 400) {
      refused += 1;
      firstRefused ??= call;
    }
    simulations.add(call.simulationId);
  }
  const sole = simulations.size === 1 ? [...simulations][0] : undefined;
  return {
    calls: detail.trajectory.length,
    mutating,
    refused,
    firstRefused,
    multiSimulation: simulations.size > 1,
    soleSimulationId: sole ?? null,
  };
}

export type TrialReplyState =
  | { state: 'text'; text: string }
  | { state: 'unresolved'; ref: string }
  | { state: 'none' }
  | { state: 'no_run' };

/** "Not fetched" and "said nothing" lead to opposite conclusions, so they are separate states. */
export function deriveTrialReplyState(detail: EvalTrialDetailView): TrialReplyState {
  if (detail.runId === undefined) return { state: 'no_run' };
  if (detail.reply !== undefined) return { state: 'text', text: detail.reply };
  if (detail.replyRef !== undefined) return { state: 'unresolved', ref: detail.replyRef };
  return { state: 'none' };
}

export interface TrialRubricGroups {
  judged: Array<Extract<EvalCaseRubricResult, { status: 'judged' }>>;
  errors: Array<Extract<EvalCaseRubricResult, { status: 'error' }>>;
  skipped: Array<Extract<EvalCaseRubricResult, { status: 'skipped_run_error' }>>;
  notSelected: Array<Extract<EvalCaseRubricResult, { status: 'not_selected' }>>;
  pending: string[];
  /** Judged rows whose verdict differs from the trial's — null when there is no verdict to compare. */
  disagree: number | null;
  /** Every judged row returned pass while the trial verdict is fail. */
  allJudgedPass: boolean;
}

export function deriveTrialRubricGroups(detail: EvalTrialDetailView): TrialRubricGroups {
  const groups: TrialRubricGroups = {
    judged: [],
    errors: [],
    skipped: [],
    notSelected: [],
    pending: [...detail.pendingRubrics],
    disagree: null,
    allJudgedPass: false,
  };
  for (const result of detail.rubricResults) {
    switch (result.status) {
      case 'judged':
        groups.judged.push(result);
        break;
      case 'error':
        groups.errors.push(result);
        break;
      case 'skipped_run_error':
        groups.skipped.push(result);
        break;
      case 'not_selected':
        groups.notSelected.push(result);
        break;
    }
  }
  const verdict = detail.verdict;
  if (verdict === 'pass' || verdict === 'fail') {
    groups.disagree = groups.judged.filter((row) => row.verdict !== verdict).length;
  }
  groups.allJudgedPass =
    groups.judged.length > 0 &&
    verdict === 'fail' &&
    groups.judged.every((r) => r.verdict === 'pass');
  return groups;
}

/** The judge line for a subtitle — never "0 disagree" when nothing was judged. */
export function formatJudgeSummary(groups: TrialRubricGroups, hasRubrics: boolean): string {
  if (!hasRubrics) return 'no rubrics on this suite';
  if (groups.judged.length === 0) {
    return groups.pending.length > 0
      ? 'not assessable — judges unresolved'
      : 'not assessable — no judge returned a verdict';
  }
  if (groups.disagree === null)
    return `${String(groups.judged.length)} judged — no verdict to compare`;
  return `${String(groups.judged.length)} judged, ${String(groups.disagree)} disagree`;
}

export type TrialAttributionStatus =
  | 'not_graded'
  | 'results_unreadable'
  | 'no_run'
  | 'run_incomplete'
  | 'grader_fault'
  | 'passed'
  | 'attributed'
  | 'contested'
  | 'unattributable';

export interface TrialAttribution {
  status: TrialAttributionStatus;
  headline: string;
  /** 0..3 sentences, each citing a verifiable artifact. */
  basis: string[];
  /** Cards carrying the candidate badge. */
  exits: TrialExit[];
  expandCards: TrialExit[];
  confident: boolean;
  suppressExitCards: boolean;
}

const DISPOSITION_SENTENCE: Record<EvalTrialDetailView['disposition'], string> = {
  scheduled: 'The trial is scheduled and has not run.',
  running: 'The trial is still running.',
  infra_retry: 'The trial is being retried after an infrastructure fault.',
  cancelled: 'The batch was cancelled before this trial finished.',
  never_started: 'The trial never started.',
  graded: 'The trial is marked graded but carries no verdict.',
};

function checkBasis(result: ExpectationResult): string {
  const head = `Check #${String(result.expectationIndex)} (${EXPECTATION_KIND_LABEL[result.kind]})`;
  return result.detail !== undefined
    ? `${head}: ${result.detail}`
    : `${head} failed with no detail recorded.`;
}

function judgeBasis(
  result: Extract<EvalCaseRubricResult, { status: 'judged' }>,
  failingCount: number,
): string {
  const head = `The judge failed ${result.criterionId} \u00b7 ${result.scopeKey}`;
  const tail = failingCount > 1 ? ` (${String(failingCount)} criteria failed)` : '';
  return result.rationale === ''
    ? `${head}${tail} with no rationale recorded.`
    : `${head}${tail}: ${result.rationale}`;
}

function callBasis(call: EvalTrialCallView): string {
  return `Call #${String(call.sequence)} ${call.endpointId} returned ${String(call.responseStatus)}.`;
}

function answerChecksSentence(failing: number): string {
  return `${String(failing)} check${failing === 1 ? '' : 's'} on the answer failed.`;
}

/**
 * Names one exit when the evidence separates them and withholds when it does
 * not: unreadable evidence may only demote a confident call to a contested
 * one, never assert an exit of its own.
 */
export function deriveTrialAttribution(detail: EvalTrialDetailView): TrialAttribution {
  if (detail.disposition !== 'graded' || detail.verdict === undefined) {
    return {
      status: 'not_graded',
      headline: 'Not scored yet',
      basis: [DISPOSITION_SENTENCE[detail.disposition]],
      exits: [],
      expandCards: [],
      confident: false,
      suppressExitCards: false,
    };
  }

  if (!detail.resultsReadable) {
    return {
      status: 'results_unreadable',
      headline: 'Results could not be read',
      basis: [
        "The grader's result record did not parse.",
        'The checks, judge outcomes and pending rubrics are empty because nothing was read, not because nothing fired.',
      ],
      exits: [],
      expandCards: [],
      confident: false,
      suppressExitCards: true,
    };
  }

  if (detail.runId === undefined) {
    return {
      status: 'no_run',
      headline: 'This trial never ran',
      basis: [
        'Nothing was dispatched for this trial, so there is no answer and no trajectory to read.',
      ],
      exits: [],
      expandCards: [],
      confident: false,
      suppressExitCards: false,
    };
  }

  // A failed run overrides its own grading: whatever the checks read, they read
  // it from a run that died, so the failure is the explanation.
  //
  // Cancellation is not that. A trial's run is cancelled as CLEANUP once its
  // pause has been read and graded, and reaped shortly after — so on a settled
  // trial the cancellation describes the harness, not the subject, and reading
  // it as the cause makes the panel say "no answer was produced" beside the
  // reply it just read. A trial cancelled while still running is disposition
  // 'cancelled' and never reaches here. Only a cancelled run that left nothing
  // to grade explains the trial itself.
  // `pendingRubrics` is NOT evidence: it names slots the judge never resolved.
  // Counting it here would let a genuinely cancelled rubric-bearing run past
  // the branch below and report it as a grader fault.
  const gradedEvidence = detail.expectationResults.length > 0 || detail.rubricResults.length > 0;

  if (detail.runStatus === 'failed' || (detail.runStatus === 'cancelled' && !gradedEvidence)) {
    return {
      status: 'run_incomplete',
      headline: detail.runStatus === 'failed' ? 'Run failed' : 'Run cancelled',
      basis: [
        'The run did not finish, so no answer was produced to check.',
        ...(detail.gradingError !== undefined ? [`Grader: ${detail.gradingError}`] : []),
      ],
      exits: [],
      expandCards: ['contract'],
      confident: false,
      suppressExitCards: false,
    };
  }

  if (detail.verdict === 'error' || detail.gradingError !== undefined) {
    return {
      status: 'grader_fault',
      headline: 'Scoring failed',
      basis: [
        'The check could not decide, so this is not an attribution.',
        detail.gradingError ?? 'The grader recorded no reason.',
      ],
      exits: [],
      expandCards: [],
      confident: false,
      suppressExitCards: false,
    };
  }

  const checks = deriveTrialChecks(detail);
  const facts = deriveTrialTrajectoryFacts(detail);

  if (detail.verdict === 'pass') {
    // A rubric-only case has no checks to have passed. Saying it did claims a
    // measurement nobody made, on exactly the cases the fold made legal.
    const judgeOnly = checks.total === 0 && detail.rubricResults.length > 0;
    return {
      status: 'passed',
      headline: judgeOnly ? 'Passed — every judge passed it' : 'Passed — every check passed',
      basis: [
        ...(judgeOnly ? ['No deterministic check covers this case; the judges decided it.'] : []),
        ...(facts.calls === 0 ? ['The trial passed without reaching any endpoint.'] : []),
      ],
      exits: [],
      expandCards: [],
      confident: true,
      suppressExitCards: false,
    };
  }

  const failingJudges = deriveTrialRubricGroups(detail).judged.filter(
    (row) => row.verdict === 'fail',
  );
  const firstJudgeFailure = failingJudges[0];

  // Before the no-call heuristic. A conversational case answers without
  // reaching an endpoint, so "the run reached no endpoint" is its normal shape
  // — reading that as the cause buries the judge that actually decided the
  // trial, on exactly the rubric-only cases the fold made legal.
  if (firstJudgeFailure !== undefined && checks.total === 0) {
    return {
      status: 'contested',
      headline: 'Two possible causes: the answer, or the rubric',
      basis: [
        judgeBasis(firstJudgeFailure, failingJudges.length),
        'No deterministic check covers this case, so the judge is the only instrument that ran.',
      ],
      exits: ['instruction', 'expectation'],
      expandCards: ['instruction', 'expectation'],
      confident: false,
      suppressExitCards: false,
    };
  }

  if (facts.calls === 0) {
    return {
      status: 'contested',
      headline: 'Two possible causes: the API design, or the instructions',
      basis: [
        'The run reached no endpoint.',
        'The evidence cannot separate a subject that answered without reading the world from a world the run could not reach.',
      ],
      exits: ['contract', 'instruction'],
      expandCards: ['contract', 'instruction'],
      confident: false,
      suppressExitCards: false,
    };
  }

  const firstContractFailure = checks.contract.failing[0];
  if (firstContractFailure !== undefined) {
    return {
      status: 'attributed',
      headline: 'Likely cause: the API design',
      basis: [
        checkBasis(firstContractFailure),
        ...(facts.firstRefused !== null ? [callBasis(facts.firstRefused)] : []),
      ],
      exits: ['contract'],
      expandCards: ['contract'],
      confident: true,
      suppressExitCards: false,
    };
  }

  if (facts.firstRefused !== null) {
    return {
      status: 'attributed',
      headline: 'Likely cause: the API design',
      basis: [
        callBasis(facts.firstRefused),
        'No contract check failed, so this refusal is unchecked evidence.',
      ],
      exits: ['contract'],
      expandCards: ['contract'],
      confident: true,
      suppressExitCards: false,
    };
  }

  const failingAnswerChecks = checks.instruction.failing.length;
  if (failingAnswerChecks > 0 && deriveTrialReplyState(detail).state === 'unresolved') {
    return {
      status: 'contested',
      headline: 'Two possible causes: the instructions, or the test itself',
      basis: [
        answerChecksSentence(failingAnswerChecks),
        'The answer itself could not be resolved, so the instruction reading cannot be confirmed.',
      ],
      exits: ['instruction', 'expectation'],
      expandCards: ['instruction', 'expectation'],
      confident: false,
      suppressExitCards: false,
    };
  }

  if (failingAnswerChecks > 0 && deriveTrialRubricGroups(detail).allJudgedPass) {
    return {
      status: 'contested',
      headline: 'Two possible causes: the instructions, or the test itself',
      basis: [
        answerChecksSentence(failingAnswerChecks),
        'Every judge that ran read the same answer as a pass, so the failure comes from the checks alone.',
      ],
      exits: ['instruction', 'expectation'],
      expandCards: ['instruction', 'expectation'],
      confident: false,
      suppressExitCards: false,
    };
  }

  const firstInstructionFailure = checks.instruction.failing[0];
  if (firstInstructionFailure !== undefined) {
    return {
      status: 'attributed',
      headline: 'Likely cause: the instructions',
      basis: [
        checkBasis(firstInstructionFailure),
        ...(checks.contract.total === 0
          ? ['No contract check covers this case, so the trajectory is unverified.']
          : []),
      ],
      exits: ['instruction'],
      expandCards: ['instruction'],
      confident: true,
      suppressExitCards: false,
    };
  }

  if (firstJudgeFailure !== undefined) {
    return {
      status: 'contested',
      headline: 'Two possible causes: the answer, or the rubric',
      basis: [
        judgeBasis(firstJudgeFailure, failingJudges.length),
        'Every deterministic check passed.',
      ],
      exits: ['instruction', 'expectation'],
      expandCards: ['instruction', 'expectation'],
      confident: false,
      suppressExitCards: false,
    };
  }

  return {
    status: 'unattributable',
    headline: 'Cause unclear',
    basis: ['The verdict is fail with no failing check and no failing judge recorded.'],
    exits: [],
    expandCards: [],
    confident: false,
    suppressExitCards: false,
  };
}

export interface SiblingTrial {
  trial: number;
  verdict?: EvalBatchCaseResultView['verdict'] | undefined;
  disposition: EvalBatchCaseResultView['disposition'];
}

/** Every trial of the same case, ascending — "every judge passed" reads differently at n=10. */
export function deriveSiblingTrials(
  caseResults: readonly EvalBatchCaseResultView[],
  caseRevisionId: string,
): SiblingTrial[] {
  return caseResults
    .filter((result) => result.caseRevisionId === caseRevisionId)
    .map((result) => ({
      trial: result.trial,
      ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
      disposition: result.disposition,
    }))
    .sort((a, b) => a.trial - b.trial);
}

export function formatSiblingSummary(siblings: readonly SiblingTrial[]): string | null {
  if (siblings.length < 2) return null;
  let passed = 0;
  let failed = 0;
  let other = 0;
  for (const sibling of siblings) {
    if (sibling.verdict === 'pass') passed += 1;
    else if (sibling.verdict === 'fail') failed += 1;
    else other += 1;
  }
  const total = siblings.length;
  return other === 0
    ? `${String(passed)} of ${String(total)} trials of this case passed.`
    : `${String(passed)} passed, ${String(failed)} failed, ${String(other)} not graded, of ${String(total)} trials.`;
}

// ============================================================================
// The headline reading — what the newest run produced, in one line
// ============================================================================

export interface TrialTally {
  /** Trial rows recorded so far. */
  rows: number;
  /** Rows carrying a verdict. */
  graded: number;
  passed: number;
  failed: number;
}

export function deriveTrialTally(results: readonly EvalBatchCaseResultView[]): TrialTally {
  let graded = 0;
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.verdict === undefined) continue;
    graded += 1;
    if (result.verdict === 'pass') passed += 1;
    else if (result.verdict === 'fail') failed += 1;
  }
  return { rows: results.length, graded, passed, failed };
}

/**
 * The pass count as a fraction of what was GRADED, with the ungraded rows
 * named separately — a tally over all rows would read a batch that is still
 * collecting as a batch that failed.
 */
export function formatTrialTally(tally: TrialTally): string | null {
  if (tally.rows === 0) return null;
  if (tally.graded === 0) return `0 of ${String(tally.rows)} trials graded`;
  const core = `${String(tally.passed)}/${String(tally.graded)} trials passed`;
  const ungraded = tally.rows - tally.graded;
  return ungraded > 0 ? `${core} · ${String(ungraded)} not graded yet` : core;
}

/** A batch's one-line reading in a rail row: its size and what it has spent. */
export function formatBatchSize(input: {
  caseCount: number;
  trialsPerCase: number;
  costSpentCents: number;
  costCeilingCents: number;
}): string {
  const cases = `${String(input.caseCount)} case${input.caseCount === 1 ? '' : 's'}`;
  const trials = `${String(input.trialsPerCase)} trial${input.trialsPerCase === 1 ? '' : 's'}`;
  return `${cases} × ${trials} · ${formatCents(input.costSpentCents)} of ${formatCents(input.costCeilingCents)}`;
}

// ============================================================================
// Review queue shaping
// ============================================================================

export interface ReviewGroup {
  caseRevisionId: string;
  caseTitle: string;
  items: LabelQueueItem[];
}

export interface ReviewQueue {
  /** Groups of items that can actually be reviewed, one group per case. */
  groups: ReviewGroup[];
  /** Items with nothing left to read. Work cannot be done on these. */
  unavailable: LabelQueueItem[];
  /** Flattened reviewable items, group order — what the rail and the walk share. */
  order: LabelQueueItem[];
}

export interface ItemReadability {
  readable: boolean;
  /** Why there is nothing to read, in the words the clearing lane shows. */
  reason: string | null;
}

/**
 * Why an unreadable item cannot be read, said once for a pile of them.
 *
 * The server's own `detail` is written to one reviewer about one item and
 * ends by naming the control to use, so a lane that stacks forty of them
 * repeats a singular sentence and points at a button that is not there.
 */
type UnreadableReason = Extract<EvalLabelQueueEvidence, { status: 'unavailable' }>['reason'];

/** Keyed by the union, so a new reason cannot ship without a sentence. */
const UNREADABLE_REASON: Record<UnreadableReason, string> = {
  run_reaped:
    'The runs behind these were cleaned up before a mark was recorded, so there is no reply left to read.',
  no_trial_run: 'These reference no trial run, so nothing was ever recorded for them.',
  case_revision_missing:
    'The cases behind these are gone from the dataset, so the material cannot be rebuilt.',
  payload_store_unavailable: 'The material behind these could not be retrieved.',
  rebuild_failed: 'The material behind these could not be rebuilt.',
};

/**
 * Whether an item carries material a verdict could be formed from.
 *
 * Three states arrive as "not reviewable" and only one of them announces
 * itself: a reaped run carries a reason code, an item that shipped without
 * evidence says nothing, and an item whose trial produced neither a reply nor
 * an evidence block renders as an empty panel. Routing on the status alone
 * holds back the first and walks the other two into the labelling form with a
 * blank area where the exchange should be.
 */
export function deriveItemReadability(item: {
  evidence?: EvalLabelQueueEvidence | undefined;
}): ItemReadability {
  const evidence = item.evidence;
  if (evidence === undefined) {
    return {
      readable: false,
      reason: 'The judge’s evidence was not included with these, so there is nothing to read.',
    };
  }
  if (evidence.status === 'unavailable') {
    return {
      readable: false,
      reason: UNREADABLE_REASON[evidence.reason],
    };
  }
  const hasReply = evidence.conversation?.reply != null;
  if (hasReply || deriveJudgeEvidenceView(evidence).blocks.length > 0) {
    return { readable: true, reason: null };
  }
  return {
    readable: false,
    reason: 'These trials produced no reply and no evidence, so there is nothing to read.',
  };
}

/**
 * Split the queue into what can be reviewed and what cannot, and group the
 * rest by case.
 *
 * Both halves matter. An item with nothing to read asks the reviewer to guess;
 * it is separated rather than hidden because it still needs clearing. Grouping
 * is what makes the list legible at all — a queue samples trials, so one case
 * supplies many items and a flat list repeats its title until the titles stop
 * being read.
 */
export function deriveReviewQueue(items: readonly LabelQueueItem[]): ReviewQueue {
  const unavailable: LabelQueueItem[] = [];
  const byCase = new Map<string, ReviewGroup>();

  for (const item of items) {
    if (!deriveItemReadability(item).readable) {
      unavailable.push(item);
      continue;
    }
    // Keyed by title, not revision id: a queue spans batches, each pinned to a
    // different dataset version, so one case arrives under several revision
    // ids and grouping by id repeats its heading once per version.
    const title = item.caseTitle ?? item.caseRevisionId.slice(0, 8);
    const existing = byCase.get(title);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    byCase.set(title, {
      caseRevisionId: item.caseRevisionId,
      caseTitle: title,
      items: [item],
    });
  }

  const groups = [...byCase.values()];
  // Trials read in question-then-trial order, not arrival order — the walk
  // and the rail are the same flattening, so both stay coherent.
  for (const group of groups) {
    group.items.sort(
      (a, b) =>
        deriveRubricQuestionView(a).title.localeCompare(deriveRubricQuestionView(b).title) ||
        a.trial - b.trial,
    );
  }
  return { groups, unavailable, order: groups.flatMap((group) => group.items) };
}

export interface QueuePosition {
  index: number;
  item: LabelQueueItem;
}

/**
 * Where the open item sits in the walk.
 *
 * An id that is not in the walk means the item in hand was just resolved and
 * has left the queue, so falling to the head IS the advance to the next one —
 * the rule that makes submitting a mark move the page on.
 */
export function deriveQueuePosition(
  order: readonly LabelQueueItem[],
  openId: string,
): QueuePosition | null {
  const found = order.findIndex((item) => item.id === openId);
  const index = found === -1 ? 0 : found;
  const item = order[index];
  return item === undefined ? null : { index, item };
}

/**
 * Which cases the unreadable pile came from.
 *
 * A whole batch whose runs were reaped arrives as one case contributing every
 * item, and that reads very differently from a scatter across the dataset —
 * the count alone cannot tell them apart.
 */
export function summariseUnreadable(items: readonly LabelQueueItem[]): string {
  const byTitle = new Map<string, number>();
  for (const item of items) {
    const title = item.caseTitle ?? item.caseRevisionId.slice(0, 8);
    byTitle.set(title, (byTitle.get(title) ?? 0) + 1);
  }
  const ordered = [...byTitle.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `From: ${ordered.map(([title, count]) => `${title} (${String(count)})`).join(', ')}`;
}

export interface SubmitGate {
  canSubmit: boolean;
  /** Why the verdict buttons are shut, never left to be inferred from grey. */
  hint: string | null;
}

/**
 * One place that decides whether a verdict can be recorded, and says why not.
 *
 * The enable rule reaches three surfaces — the buttons, the keyboard handler
 * and the hint under them — and a rule stated three times is a rule that can
 * disagree with itself.
 */
export function deriveSubmitGate(input: {
  critique: string;
  pending: boolean;
  readable: boolean;
}): SubmitGate {
  if (!input.readable) {
    return {
      canSubmit: false,
      hint: 'There is nothing to read here, so this item cannot be marked. Discard it.',
    };
  }
  if (input.pending) return { canSubmit: false, hint: 'Recording…' };
  if (input.critique.trim().length === 0) {
    return { canSubmit: false, hint: 'A reason is required before marking.' };
  }
  return { canSubmit: true, hint: null };
}

const EVIDENCE_PREVIEW_MAX = 80;

/**
 * An evidence block's first line, as the accordion subtitle.
 *
 * A byte count tells a reader nothing about whether the block is worth
 * opening; the first line of it usually settles that in one glance.
 */
export function formatEvidencePreview(block: JudgeEvidenceBlock): string {
  const first =
    block.content
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? '';
  if (first === '') return 'empty';
  return first.length > EVIDENCE_PREVIEW_MAX ? `${first.slice(0, EVIDENCE_PREVIEW_MAX)}…` : first;
}

// ============================================================================
// Case review
// ============================================================================

/**
 * How a requirement is checked, which decides how far it can be trusted.
 *
 * `text match` is a regular expression over the reply, so it holds only for
 * strings that survive translation — an identifier does, an amount written in
 * Arabic-Indic digits or a merchant name in Arabic script does not. Anything
 * about phrasing belongs to `judge` for that reason. `tool call` and `world
 * change` read the journal and are language-independent.
 */
export type CaseInstrument = 'text match' | 'tool call' | 'world change' | 'run status';

export interface CaseRequirement {
  /** The plain statement the case author wrote, or a fallback built from the check. */
  text: string;
  /** How it is actually checked, for the reader who wants it. */
  detail: string;
  /** A requirement stated as a prohibition reads differently and is marked. */
  forbidden: boolean;
  instrument: CaseInstrument;
}

export interface CaseReview {
  request: string | null;
  personaId: string | null;
  worldId: string | null;
  requirements: CaseRequirement[];
  judgeAsks: string[];
  why: string | null;
}

function replyRequirement(
  expectation: Extract<CaseExpectation, { kind: 'reply' }>,
): CaseRequirement {
  const forbidden = expectation.check.op === 'not_contains';
  const where = expectation.taskId === undefined ? 'the reply' : `task '${expectation.taskId}'`;
  return {
    text: expectation.name ?? (forbidden ? 'Avoids a phrase' : 'Says something specific'),
    detail: `${where} ${forbidden ? 'must not match' : 'must match'} ${expectation.check.pattern}`,
    forbidden,
    instrument: 'text match',
  };
}

function simulationRequirement(
  expectation: Extract<CaseExpectation, { kind: 'simulation' }>,
): CaseRequirement {
  const { check } = expectation;
  const forbidden = check.expect === 'none';
  if (check.op === 'called') {
    const status = check.status !== undefined ? ` returning ${check.status}` : '';
    return {
      text:
        expectation.name ??
        (forbidden ? `Does not call ${check.endpointId}` : `Calls ${check.endpointId}`),
      detail: `${forbidden ? 'never calls' : 'calls'} ${check.endpointId}${status}`,
      forbidden,
      instrument: 'tool call',
    };
  }
  const change = check.change !== undefined ? `${check.change}s a row in` : 'changes';
  return {
    text:
      expectation.name ??
      (forbidden ? `Leaves ${check.collection} alone` : `Changes ${check.collection}`),
    detail: `${forbidden ? 'never changes' : change} ${check.collection}`,
    forbidden,
    instrument: 'world change',
  };
}

/**
 * A case rendered as the thing it describes, rather than as its storage.
 *
 * The reviewer's question is whether the case is RIGHT — whether this request,
 * in this world, ought to demand these things. The identifiers it is stored
 * under (revision ids, baseline versions, expectation indices) answer a
 * different question and crowd out the one being asked.
 */
export function deriveCaseReview(content: GoldenCaseContent): CaseReview {
  const binding = content.fixture.bindings?.[0];
  const requirements: CaseRequirement[] = [];

  for (const expectation of content.expectations) {
    if (expectation.kind === 'reply') {
      requirements.push(replyRequirement(expectation));
      continue;
    }
    if (expectation.kind === 'simulation') {
      requirements.push(simulationRequirement(expectation));
      continue;
    }
    if (expectation.kind === 'terminal') {
      requirements.push({
        text: `Ends as '${expectation.runStatus}'`,
        detail: `run status '${expectation.runStatus}'`,
        forbidden: false,
        instrument: 'run status',
      });
      continue;
    }
    requirements.push({
      text: `A ${expectation.kind} check`,
      detail: expectation.kind,
      forbidden: false,
      instrument: 'run status',
    });
  }

  return {
    request: firstCaseInput(content.trigger.inputs),
    personaId: binding?.personaId ?? null,
    worldId: binding?.simulationId ?? null,
    requirements,
    judgeAsks: content.rubrics.flatMap((rubric) =>
      rubric.kind === 'case_local' ? rubric.criterion.rubric.map((entry) => entry.criterion) : [],
    ),
    why: content.notes ?? null,
  };
}

function firstCaseInput(inputs: Readonly<Record<string, unknown>>): string | null {
  for (const value of Object.values(inputs)) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

// ============================================================================
// Case rollup
// ============================================================================

export interface CaseRollupRow {
  caseRevisionId: string;
  caseTitle: string;
  scenario: string | null;
  tier: string | null;
  trials: EvalBatchCaseResultView[];
  /** Trials carrying a behavioural claim. */
  scored: number;
  passed: number;
  total: number;
  /**
   * Trials excluded from the behavioural claim, by why. An execution error is
   * not a failing case and an unsound fixture is not a failing agent, so the
   * count that reads as a result never absorbs either.
   */
  excluded: { invalid_case: number; execution_error: number; incomplete_evidence: number };
  /** A scored trial that did not pass — the reason to look at this case. */
  anyFailing: boolean;
  /** Every configured trial was scored, so a pass^k claim is available. */
  complete: boolean;
  /** pass^k — complete AND every scored trial passed. */
  passAllTrials: boolean;
  costCents: number;
}

/**
 * One row per case, trials folded underneath.
 *
 * A batch repeats each case once per trial, so the flat list spends the
 * reader's attention proportionally to the number of trials rather than to
 * what is wrong: eighteen rows, fifteen of them identical and green. The
 * rollup states the reliability the trials were run to measure — 3 of 3 — and
 * keeps the trials themselves for the case that earns a second look.
 */
export function deriveCaseRollup(
  caseResults: readonly EvalBatchCaseResultView[],
  trialsPerCase: number,
): CaseRollupRow[] {
  const byCase = new Map<string, CaseRollupRow>();
  for (const result of caseResults) {
    const existing = byCase.get(result.caseRevisionId);
    const row =
      existing ??
      ({
        caseRevisionId: result.caseRevisionId,
        caseTitle: result.caseTitle ?? result.caseRevisionId.slice(0, 8),
        scenario: result.scenario ?? null,
        tier: result.tier ?? null,
        trials: [],
        scored: 0,
        passed: 0,
        total: 0,
        excluded: { invalid_case: 0, execution_error: 0, incomplete_evidence: 0 },
        anyFailing: false,
        complete: false,
        passAllTrials: false,
        costCents: 0,
      } satisfies CaseRollupRow);
    row.trials.push(result);
    row.total += 1;
    row.costCents += result.costCents ?? 0;
    byCase.set(result.caseRevisionId, row);
  }
  for (const row of byCase.values()) {
    row.trials.sort((a, b) => a.trial - b.trial);
    const summary = summariseCaseOutcome(collectOutcomeClasses(row.trials), trialsPerCase);
    row.scored = summary.scored;
    row.passed = summary.passed;
    row.excluded = summary.excluded;
    row.complete = summary.complete;
    row.passAllTrials = summary.passAllTrials;
    row.anyFailing = summary.scored > summary.passed;
  }
  // Anything not fully passing first: the reader's question is what broke.
  return [...byCase.values()].sort((a, b) => Number(b.anyFailing) - Number(a.anyFailing));
}

/**
 * A row graded before the class was stored carries none. Folding `verdict`
 * here as a stand-in would reinstate the divergence the stored class removes,
 * so an unclassified trial counts as evidence that could not be read.
 */
function collectOutcomeClasses(trials: readonly EvalBatchCaseResultView[]): TrialOutcomeClass[] {
  return trials.map((trial) => trial.outcomeClass ?? 'incomplete_evidence');
}

/** The route's machine-readable error code, when the body carried one. */
export function readApiErrorCode(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const code = (body as { error?: unknown }).error;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export interface SubmitFailure {
  text: string;
  /**
   * The item can never be marked from here, so the page has to offer a way
   * past it — a refusal with no exit pins the queue on one row forever.
   */
  stranded: boolean;
}

/**
 * What a refused mark means, in the reviewer's terms.
 *
 * Two of these are terminal for the item and one is not, and the bare server
 * sentence does not separate them: a conflict says the work is already done
 * elsewhere, a missing trial run says the item was never markable, and
 * everything else is worth trying again.
 */
export function deriveSubmitFailure(input: {
  status: number;
  code: string | null;
  message: string;
}): SubmitFailure {
  if (
    input.status === 409 &&
    (input.code === 'label_exists' || input.code === 'queue_item_resolved')
  ) {
    return {
      text: 'This item was already resolved elsewhere, so it cannot be marked here.',
      stranded: true,
    };
  }
  if (input.status === 409 && input.code === 'queue_item_unlabelable') {
    return {
      text: 'This item references no trial run, so there is nothing to mark. Discard it.',
      stranded: false,
    };
  }
  return { text: `The mark was not recorded. ${input.message}`, stranded: false };
}
