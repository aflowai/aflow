/**
 * Paired batch comparison + capability-graduation flag (Plan 269 D12) —
 * pure functions over frozen membership and trial-row snapshots, so every
 * statistic is unit-testable against hand-built fixtures. Pairing happens
 * on the intersection of IDENTICAL case revisions; everything outside it
 * (added/removed/edited/undecided/unresolved) is reported, never silently
 * dropped. The delta intervals are percentile bootstraps CLUSTERED BY CASE
 * under an injected/seeded RNG — recompute-at-read returns identical
 * intervals.
 */
import type {
  EvalBatchComparison,
  EvalBatchCompareSide,
  EvalBatchDimensionChange,
  EvalBatchDelta,
  EvalBatchEditedCase,
  EvalBatchExcludedCase,
  EvalBatchFlip,
  EvalBatchUndecidedCase,
  EvalGraduationCandidate,
  GoldenCaseTier,
} from '@aflow/schemas';
import { stableHash } from '@aflow/schemas';
import { EvalBatchComparisonSchema, EvalGraduationCandidateSchema } from '@aflow/schemas';
import { createSeededRng, seedFromString } from './judgeScorecard.js';

/** Case-clustered percentile-bootstrap resample count for delta intervals. */
export const COMPARISON_BOOTSTRAP_RESAMPLES = 1000;
const BOOTSTRAP_LOWER_QUANTILE = 0.025;
const BOOTSTRAP_UPPER_QUANTILE = 0.975;

// ============================================================================
// Inputs
// ============================================================================

export interface CompareTrialRow {
  caseRevisionId: string;
  trial: number;
  disposition: string;
  verdict: string | null;
  /**
   * The stored fold. `verdict` is the DETERMINISTIC half only — a trial whose
   * judge rejected its quality claim stores `behavior_fail` here while
   * `verdict` stays `pass`, so reading the verdict would count a judge-gated
   * failure as a success in every delta and every graduation decision.
   */
  outcomeClass: string | null;
  runId: string | null;
}

export interface CompareCaseMeta {
  caseId: string;
  title: string;
  scenario: string;
  tier: GoldenCaseTier;
}

// ============================================================================
// Per-case aggregation
// ============================================================================

interface CaseOutcome {
  /** Trials with a real pass/fail verdict ('error' is grader fault, not a verdict). */
  decidedTrials: number;
  passedTrials: number;
  /** Every trial decided — the case can carry a pass^k claim. */
  decided: boolean;
  /** pass^k: decided && every trial passed. */
  success: boolean;
  /** Trial runIds ordered by trial index. */
  runIds: string[];
}

function collectCaseOutcomes(
  rows: readonly CompareTrialRow[],
  trialsPerCase: number,
): Map<string, CaseOutcome> {
  const byCase = new Map<
    string,
    { decided: number; passed: number; runs: Array<[number, string]> }
  >();
  for (const row of rows) {
    const entry = byCase.get(row.caseRevisionId) ?? { decided: 0, passed: 0, runs: [] };
    if (
      row.disposition === 'graded' &&
      (row.outcomeClass === 'behavior_pass' || row.outcomeClass === 'behavior_fail')
    ) {
      entry.decided += 1;
      if (row.outcomeClass === 'behavior_pass') entry.passed += 1;
    }
    if (row.runId !== null) entry.runs.push([row.trial, row.runId]);
    byCase.set(row.caseRevisionId, entry);
  }
  const outcomes = new Map<string, CaseOutcome>();
  for (const [revisionId, entry] of byCase) {
    const decided = entry.decided === trialsPerCase;
    outcomes.set(revisionId, {
      decidedTrials: entry.decided,
      passedTrials: entry.passed,
      decided,
      success: decided && entry.passed === entry.decided,
      runIds: entry.runs.sort((a, b) => a[0] - b[0]).map(([, runId]) => runId),
    });
  }
  return outcomes;
}

// ============================================================================
// The comparison
// ============================================================================

interface PairedCase {
  caseRevisionId: string;
  meta: CompareCaseMeta;
  a: CaseOutcome;
  b: CaseOutcome;
}

function metricRates(pairs: readonly PairedCase[]): {
  perCaseSuccess: [number, number];
  passAny: [number, number];
  trialPass: [number, number];
} {
  let successA = 0;
  let successB = 0;
  let anyA = 0;
  let anyB = 0;
  let trialsA = 0;
  let trialsB = 0;
  let trialPassA = 0;
  let trialPassB = 0;
  for (const pair of pairs) {
    if (pair.a.success) successA += 1;
    if (pair.b.success) successB += 1;
    if (pair.a.passedTrials > 0) anyA += 1;
    if (pair.b.passedTrials > 0) anyB += 1;
    trialsA += pair.a.decidedTrials;
    trialsB += pair.b.decidedTrials;
    trialPassA += pair.a.passedTrials;
    trialPassB += pair.b.passedTrials;
  }
  const n = pairs.length;
  return {
    perCaseSuccess: [n > 0 ? successA / n : 0, n > 0 ? successB / n : 0],
    passAny: [n > 0 ? anyA / n : 0, n > 0 ? anyB / n : 0],
    trialPass: [trialsA > 0 ? trialPassA / trialsA : 0, trialsB > 0 ? trialPassB / trialsB : 0],
  };
}

function percentile(sorted: readonly number[], quantile: number, upper: boolean): number {
  if (upper) return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
}

function buildDelta(
  rateA: number,
  rateB: number,
  resampleDeltas: readonly number[],
): EvalBatchDelta {
  const sorted = [...resampleDeltas].sort((a, b) => a - b);
  return {
    rateA,
    rateB,
    delta: rateB - rateA,
    intervalLower: percentile(sorted, BOOTSTRAP_LOWER_QUANTILE, false),
    intervalUpper: percentile(sorted, BOOTSTRAP_UPPER_QUANTILE, true),
  };
}

export interface CompareEvalBatchesParams {
  batchA: EvalBatchCompareSide;
  batchB: EvalBatchCompareSide;
  /** Frozen memberships from `eval_batch_members`. */
  memberRevisionIdsA: readonly string[];
  memberRevisionIdsB: readonly string[];
  trialRowsA: readonly CompareTrialRow[];
  trialRowsB: readonly CompareTrialRow[];
  caseMetaByRevisionId: ReadonlyMap<string, CompareCaseMeta>;
  /** Injectable for tests; defaults to a seed derived from the batch ids. */
  rng?: () => number;
  resamples?: number;
}

/**
 * Read the two manifests into one changed/same/unknown answer per dimension.
 *
 * Identity-only dimensions say a thing moved without saying what: a
 * `simulationRevision` bump does not name the handler that changed, and the
 * prior artifact is not retained to diff against. That is reported as changed
 * with the limit stated, never as a silent omission.
 */
function compareDimensions(
  a: EvalBatchCompareSide,
  b: EvalBatchCompareSide,
): EvalBatchDimensionChange[] {
  const out: EvalBatchDimensionChange[] = [];
  const push = (
    dimension: EvalBatchDimensionChange['dimension'],
    status: EvalBatchDimensionChange['status'],
    detail: string,
  ): void => {
    out.push({ dimension, status, detail });
  };

  push(
    'dataset',
    a.datasetVersion === b.datasetVersion ? 'same' : 'changed',
    `v${String(a.datasetVersion)} → v${String(b.datasetVersion)}`,
  );

  const ma = a.manifest;
  const mb = b.manifest;
  if (ma === undefined || mb === undefined) {
    push('case_content', 'unknown', 'one side recorded no manifest');
    push('subject_graph', 'unknown', 'one side recorded no manifest');
    push('subject_models', 'unknown', 'one side recorded no manifest');
    push('agent_version', 'unknown', 'one side recorded no manifest');
    push('api_contract', 'unknown', 'one side recorded no manifest');
    push('simulated_world', 'unknown', 'one side recorded no manifest');
    push('grader', 'unknown', 'one side recorded no manifest');
    push('judges', 'unknown', 'one side recorded no manifest');
    return out;
  }

  const sameRecord = (x: Record<string, unknown>, y: Record<string, unknown>): boolean =>
    stableHash(x) === stableHash(y);

  const bothEmpty = (x: Record<string, unknown>, y: Record<string, unknown>): boolean =>
    Object.keys(x).length === 0 && Object.keys(y).length === 0;

  if (bothEmpty(ma.caseContentHashes, mb.caseContentHashes)) {
    push('case_content', 'unknown', 'neither side recorded case content hashes');
  } else {
    const changed = [
      ...new Set([...Object.keys(ma.caseContentHashes), ...Object.keys(mb.caseContentHashes)]),
    ].filter((id) => ma.caseContentHashes[id] !== mb.caseContentHashes[id]);
    push(
      'case_content',
      changed.length === 0 ? 'same' : 'changed',
      changed.length === 0
        ? 'every shared case identical'
        : `${String(changed.length)} case(s) differ`,
    );
  }

  push(
    'subject_graph',
    ma.workflow.configHash === mb.workflow.configHash ? 'same' : 'changed',
    ma.workflow.configHash === mb.workflow.configHash
      ? `revision ${String(ma.workflow.revision)}`
      : 'task graph or state variables differ — the manifest hashes them, so which part changed is not recoverable',
  );

  const sameSubjectModels = stableHash(ma.subjectModels) === stableHash(mb.subjectModels);
  push(
    'subject_models',
    sameSubjectModels ? 'same' : 'changed',
    sameSubjectModels ? 'identical model assignment' : 'the subject ran on different models',
  );

  if (bothEmpty(ma.agentVersions, mb.agentVersions)) {
    push('agent_version', 'unknown', 'neither side pinned an agent version');
  } else {
    const samePins = sameRecord(ma.agentVersions, mb.agentVersions);
    push(
      'agent_version',
      samePins ? 'same' : 'changed',
      samePins ? 'same pinned agent version(s)' : 'an agent task resolved to a different version',
    );
  }

  if (ma.apiContractHash === undefined || mb.apiContractHash === undefined) {
    push('api_contract', 'unknown', 'one side recorded no API contract hash');
  } else {
    push(
      'api_contract',
      ma.apiContractHash === mb.apiContractHash ? 'same' : 'changed',
      ma.apiContractHash === mb.apiContractHash
        ? 'the tool surface the agent reads is identical'
        : 'endpoint names, descriptions or input schemas differ — which endpoint is not recoverable from the hash',
    );
  }

  if (bothEmpty(ma.sealedSources, mb.sealedSources)) {
    push('simulated_world', 'unknown', 'neither side sealed a world');
  } else if (!sameRecord(ma.sealedSources, mb.sealedSources)) {
    push(
      'simulated_world',
      'changed',
      'the simulation revision or baseline moved — which handler changed is not recoverable, and prior artifacts are not retained',
    );
  } else if (ma.platform.buildVersion === undefined || mb.platform.buildVersion === undefined) {
    // A code-rung handler lives in a deployed package, not in the simulation
    // row, so editing one moves the world without moving its revision. With no
    // build version on both sides there is nothing that would have changed,
    // and reporting `same` here would assert a world held still while its
    // handlers were rewritten underneath it.
    push(
      'simulated_world',
      'unknown',
      'same simulation revision and baseline, but neither side recorded a build version — a code-rung handler changes behaviour without moving either',
    );
  } else if (ma.platform.buildVersion !== mb.platform.buildVersion) {
    push(
      'simulated_world',
      'changed',
      `same simulation revision, different build (${ma.platform.buildVersion} → ${mb.platform.buildVersion}) — a code-rung handler may have changed`,
    );
  } else {
    push('simulated_world', 'same', 'same simulation revision, baseline and build');
  }

  push(
    'grader',
    ma.graderVersion === mb.graderVersion ? 'same' : 'changed',
    `${ma.graderVersion} → ${mb.graderVersion}`,
  );

  if (bothEmpty(ma.judgeVersions, mb.judgeVersions)) {
    push('judges', 'unknown', 'neither side recorded judge versions');
  } else {
    const sameJudges = sameRecord(ma.judgeVersions, mb.judgeVersions);
    push(
      'judges',
      sameJudges ? 'same' : 'changed',
      sameJudges
        ? 'same judge version for every slot'
        : 'a rubric, judge model, prompt template or evidence format changed',
    );
  }

  return out;
}

export function compareEvalBatches(params: CompareEvalBatchesParams): EvalBatchComparison {
  const { batchA, batchB, caseMetaByRevisionId } = params;
  const resamples = params.resamples ?? COMPARISON_BOOTSTRAP_RESAMPLES;
  const rng = params.rng ?? createSeededRng(seedFromString(`${batchA.batchId} ${batchB.batchId}`));

  const unresolvedRevisionIds = new Set<string>();
  const byCaseIdA = new Map<string, string>();
  const byCaseIdB = new Map<string, string>();
  for (const [members, byCaseId] of [
    [params.memberRevisionIdsA, byCaseIdA],
    [params.memberRevisionIdsB, byCaseIdB],
  ] as const) {
    for (const revisionId of members) {
      const meta = caseMetaByRevisionId.get(revisionId);
      if (meta === undefined) {
        unresolvedRevisionIds.add(revisionId);
        continue;
      }
      byCaseId.set(meta.caseId, revisionId);
    }
  }

  const outcomesA = collectCaseOutcomes(params.trialRowsA, batchA.trialsPerCase);
  const outcomesB = collectCaseOutcomes(params.trialRowsB, batchB.trialsPerCase);

  const added: EvalBatchExcludedCase[] = [];
  const removed: EvalBatchExcludedCase[] = [];
  const edited: EvalBatchEditedCase[] = [];
  const undecided: EvalBatchUndecidedCase[] = [];
  const paired: PairedCase[] = [];

  const excludedCase = (caseId: string, revisionId: string): EvalBatchExcludedCase => {
    const title = caseMetaByRevisionId.get(revisionId)?.title;
    return {
      caseId,
      caseRevisionId: revisionId,
      ...(title !== undefined ? { caseTitle: title } : {}),
    };
  };

  const caseIds = [...new Set([...byCaseIdA.keys(), ...byCaseIdB.keys()])].sort();
  for (const caseId of caseIds) {
    const revisionA = byCaseIdA.get(caseId);
    const revisionB = byCaseIdB.get(caseId);
    if (revisionA === undefined) {
      added.push(excludedCase(caseId, revisionB!));
      continue;
    }
    if (revisionB === undefined) {
      removed.push(excludedCase(caseId, revisionA));
      continue;
    }
    if (revisionA !== revisionB) {
      const title = caseMetaByRevisionId.get(revisionB)?.title;
      edited.push({
        caseId,
        caseRevisionIdA: revisionA,
        caseRevisionIdB: revisionB,
        ...(title !== undefined ? { caseTitle: title } : {}),
      });
      continue;
    }
    const meta = caseMetaByRevisionId.get(revisionA)!;
    const a = outcomesA.get(revisionA);
    const b = outcomesB.get(revisionA);
    if (a === undefined || b === undefined || !a.decided || !b.decided) {
      undecided.push({
        caseId,
        caseRevisionId: revisionA,
        caseTitle: meta.title,
        decidedTrialsA: a?.decidedTrials ?? 0,
        decidedTrialsB: b?.decidedTrials ?? 0,
      });
      continue;
    }
    paired.push({ caseRevisionId: revisionA, meta, a, b });
  }

  const flips: EvalBatchFlip[] = paired
    .filter((pair) => pair.a.success !== pair.b.success)
    .map((pair) => ({
      caseId: pair.meta.caseId,
      caseRevisionId: pair.caseRevisionId,
      caseTitle: pair.meta.title,
      scenario: pair.meta.scenario,
      tier: pair.meta.tier,
      direction: pair.a.success ? ('pass_to_fail' as const) : ('fail_to_pass' as const),
      finding:
        pair.meta.tier === 'regression' ? ('investigation' as const) : ('informational' as const),
      passedTrialsA: pair.a.passedTrials,
      passedTrialsB: pair.b.passedTrials,
      runIdsA: pair.a.runIds,
      runIdsB: pair.b.runIds,
    }));

  let deltas: Pick<EvalBatchComparison, 'perCaseSuccess' | 'passAny' | 'trialPass'> = {};
  let bootstrapResamples = 0;
  if (paired.length > 0) {
    const observed = metricRates(paired);
    const successDeltas: number[] = [];
    const anyDeltas: number[] = [];
    const trialDeltas: number[] = [];
    for (let b = 0; b < resamples; b += 1) {
      const resample = paired.map(() => paired[Math.floor(rng() * paired.length)]!);
      const rates = metricRates(resample);
      successDeltas.push(rates.perCaseSuccess[1] - rates.perCaseSuccess[0]);
      anyDeltas.push(rates.passAny[1] - rates.passAny[0]);
      trialDeltas.push(rates.trialPass[1] - rates.trialPass[0]);
    }
    bootstrapResamples = resamples;
    deltas = {
      perCaseSuccess: buildDelta(...observed.perCaseSuccess, successDeltas),
      passAny: buildDelta(...observed.passAny, anyDeltas),
      trialPass: buildDelta(...observed.trialPass, trialDeltas),
    };
  }

  const changedDimensions = compareDimensions(batchA, batchB);
  const identicalDatasetVersion = batchA.datasetVersion === batchB.datasetVersion;
  const identicalTrialsPerCase = batchA.trialsPerCase === batchB.trialsPerCase;
  const noteParts: string[] = [
    `Paired on ${String(paired.length)} identical case revision(s) fully decided on both sides` +
      ` (trials: ${String(batchA.trialsPerCase)} vs ${String(batchB.trialsPerCase)} per case).`,
  ];
  if (paired.length === 0) {
    noteParts.push('No paired cases — no deltas or intervals are computable.');
  } else {
    noteParts.push(
      `Every delta carries a 95% case-clustered bootstrap interval (${String(bootstrapResamples)} resamples); ` +
        (paired.length < 10
          ? `n=${String(paired.length)} is small — intervals are wide, read deltas as directional only.`
          : `n=${String(paired.length)}.`),
    );
  }
  const excludedTotal = added.length + removed.length + edited.length + undecided.length;
  if (excludedTotal > 0) {
    noteParts.push(
      `Excluded from the paired stats: ${String(added.length)} added, ${String(removed.length)} removed, ` +
        `${String(edited.length)} edited, ${String(undecided.length)} undecided case(s).`,
    );
  }
  if (!identicalDatasetVersion) {
    noteParts.push(
      `Dataset versions differ (v${String(batchA.datasetVersion)} vs v${String(batchB.datasetVersion)}) — ` +
        'the comparison covers only the shared revisions.',
    );
  }
  if (!identicalTrialsPerCase) {
    noteParts.push(
      `Trials per case differ (${String(batchA.trialsPerCase)} vs ${String(batchB.trialsPerCase)}) — ` +
        'pass^k and pass@k measure different bars; only the per-trial rate reads like-for-like.',
    );
  }
  const movedDimensions = changedDimensions.filter((d) => d.status === 'changed');
  const unknownDimensions = changedDimensions.filter((d) => d.status === 'unknown');
  if (movedDimensions.length > 1) {
    noteParts.push(
      `${String(movedDimensions.length)} dimensions changed (${movedDimensions
        .map((d) => d.dimension)
        .join(', ')}) — the delta is real but cannot be attributed to any one of them.`,
    );
  }
  if (unknownDimensions.length > 0) {
    noteParts.push(
      `Not comparable: ${unknownDimensions.map((d) => d.dimension).join(', ')} — ` +
        'a dimension nothing recorded is unknown, not unchanged.',
    );
  }
  const investigationFlips = flips.filter((f) => f.finding === 'investigation').length;
  if (investigationFlips > 0) {
    noteParts.push(
      `${String(investigationFlips)} regression-tier flip(s) need transcript investigation — a flip is never a verdict.`,
    );
  }

  return EvalBatchComparisonSchema.parse({
    batchA,
    batchB,
    changedDimensions,
    identicalDatasetVersion,
    identicalTrialsPerCase,
    pairedCases: paired.length,
    ...deltas,
    bootstrapResamples,
    flips,
    excluded: {
      added,
      removed,
      edited,
      undecided,
      unresolvedRevisionIds: [...unresolvedRevisionIds].sort(),
    },
    uncertaintyNote: noteParts.join(' '),
  });
}

// ============================================================================
// Capability → regression graduation flag (D12)
// ============================================================================

export interface GraduationBatchSnapshot {
  batchId: string;
  trialsPerCase: number;
  trialRows: readonly CompareTrialRow[];
}

/**
 * Capability-tier case revisions with full pass^k in EVERY one of the last
 * `graduationConsecutiveBatches` completed batches (newest first). Fewer
 * completed batches than the knob → no candidates: saturation is a claim
 * about consecutive history, not a single lucky batch. Revision identity is
 * deliberate — an edited case restarts its streak (the ruler moved).
 */
export function deriveGraduationCandidates(params: {
  completedBatchesNewestFirst: readonly GraduationBatchSnapshot[];
  caseMetaByRevisionId: ReadonlyMap<string, CompareCaseMeta>;
  graduationConsecutiveBatches: number;
}): EvalGraduationCandidate[] {
  const { caseMetaByRevisionId, graduationConsecutiveBatches } = params;
  if (params.completedBatchesNewestFirst.length < graduationConsecutiveBatches) return [];
  const window = params.completedBatchesNewestFirst.slice(0, graduationConsecutiveBatches);

  const outcomesPerBatch = window.map((batch) => ({
    batchId: batch.batchId,
    outcomes: collectCaseOutcomes(batch.trialRows, batch.trialsPerCase),
  }));

  const [newest] = outcomesPerBatch;
  const candidates: EvalGraduationCandidate[] = [];
  for (const revisionId of [...newest!.outcomes.keys()].sort()) {
    const meta = caseMetaByRevisionId.get(revisionId);
    if (meta?.tier !== 'capability') continue;
    const saturated = outcomesPerBatch.every(
      (batch) => batch.outcomes.get(revisionId)?.success === true,
    );
    if (!saturated) continue;
    candidates.push(
      EvalGraduationCandidateSchema.parse({
        caseId: meta.caseId,
        caseRevisionId: revisionId,
        caseTitle: meta.title,
        scenario: meta.scenario,
        batchIds: outcomesPerBatch.map((batch) => batch.batchId),
      }),
    );
  }
  return candidates;
}
