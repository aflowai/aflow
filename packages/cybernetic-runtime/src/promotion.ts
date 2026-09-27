import type {
  WorkflowTask,
  WorkflowTaskOutputPromotion,
  MaterializedSkillGoal,
  WorkflowRunScoreProvenance,
} from '@aflow/schemas';
import { readOutputPath } from './scheduling/outputPath.js';

/** Run-level promoted state (the `stateVariables` bag, keyed by `toState`). */
export type RunLevelMetrics = Record<string, unknown>;

/** Decoded task result shape promotion reads (subset of EvalRunnerParams.taskResults). */
export interface PromotionTaskResult {
  taskId: string;
  status: string;
  metrics?: Record<string, unknown>;
  output?: Record<string, unknown>;
  summary?: string;
}

function resolvePromotion(
  promo: WorkflowTaskOutputPromotion,
  result: PromotionTaskResult,
): unknown {
  switch (promo.kind) {
    case 'output_root':
      return result.output;
    case 'output_path':
      return result.output ? readOutputPath(result.output, promo.path) : undefined;
    case 'metric':
      return result.metrics ? result.metrics[promo.metric] : undefined;
    case 'task_summary':
      return result.summary;
  }
}

export function resolvePromotedRunMetrics(
  tasks: readonly WorkflowTask[],
  taskResults: readonly PromotionTaskResult[],
): RunLevelMetrics {
  const byId = new Map(taskResults.map((t) => [t.taskId, t]));
  const out: RunLevelMetrics = {};
  for (const task of tasks) {
    const promos = task.promoteOutputs;
    if (!promos || promos.length === 0) continue;
    const result = byId.get(task.taskId);
    if (result?.status !== 'succeeded') continue;
    for (const promo of promos) {
      const value = resolvePromotion(promo, result);
      if (value !== undefined) out[promo.toState] = value;
    }
  }
  return out;
}

/** Coerce a promoted value to a finite number (tolerates numeric strings). */
export function coerceNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function derivePrimaryScore(
  goal: MaterializedSkillGoal,
  runLevelMetrics: RunLevelMetrics,
  opts: { evalResultRef?: string; normalizedScore?: number } = {},
): { score: number; provenance: WorkflowRunScoreProvenance } | null {
  if (goal.type !== 'numeric') return null;
  const num = coerceNumeric(runLevelMetrics[goal.metricKey]);
  if (num === null) return null;
  return {
    score: num,
    provenance: {
      kind: 'metric',
      metricKey: goal.metricKey,
      rawValue: num,
      direction: goal.direction,
      whyPrimary: `numeric goal metricKey='${goal.metricKey}' (${goal.direction})`,
      ...(opts.normalizedScore !== undefined ? { normalizedScore: opts.normalizedScore } : {}),
      ...(opts.evalResultRef !== undefined ? { evalResultRef: opts.evalResultRef } : {}),
    },
  };
}

export function bestScoreByDirection(
  scores: ReadonlyArray<number | null | undefined>,
  direction: 'maximize' | 'minimize',
): number | undefined {
  // A loop, not `Math.min/max(...scores)` — the campaign series is unbounded and
  // the spread form throws ("Maximum call stack size exceeded") on large arrays.
  let best: number | undefined;
  for (const s of scores) {
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    if (best === undefined || (direction === 'minimize' ? s < best : s > best)) best = s;
  }
  return best;
}

/**
 * Hartley's `d2` for a moving range of subgroup size 2 — the unbiasing constant
 * that turns the mean moving-range into an estimate of σ
 * (`σ̂ = mean(|xᵢ − xᵢ₋₁|) / d2`). A principled statistical constant, not a
 * tuned threshold. See any SPC / control-chart reference (e.g. Montgomery).
 */
const MOVING_RANGE_D2 = 1.128;

export interface TrajectoryRegressionOptions {
  /** Min scored runs before a verdict — below it, drift can't be told from
   *  noise (eval/bootstrap cover early campaigns). */
  minRuns: number;
  /** How many most-recent runs form the "current level" window. */
  recentWindow: number;
  /** σ-multiples: fire when the recent-window mean is ≥ k·σ below the baseline
   *  peak. The ONLY free literal — dimensionless and scale-invariant. */
  k: number;
}

export interface TrajectoryRegressionResult {
  regressed: boolean;
  /** Best score over the full series (direction-aware). */
  peak: number;
  /** The most-recent score. */
  latest: number;
  /** Mean of the recent window — the current level. */
  recentMean: number;
  /** σ estimated from the baseline moving-range (drift-immune). */
  sigma: number;
  /** How many σ the recent mean sits below peak (direction-aware). */
  nSigma: number;
  /** Number of baseline runs σ was estimated over (for the legible reason string). */
  baselineCount: number;
}

export function detectTrajectoryRegression(
  series: readonly number[],
  direction: 'maximize' | 'minimize',
  opts: TrajectoryRegressionOptions,
): TrajectoryRegressionResult | null {
  const finite = series.filter((s) => Number.isFinite(s));
  if (finite.length < opts.minRuns) return null;

  const w = Math.max(1, Math.floor(opts.recentWindow));
  const recent = finite.slice(-w);
  // The baseline is the "in-control" history — it EXCLUDES the runs under test
  // so the drift being judged can't inflate the σ that judges it.
  const baseline = finite.slice(0, finite.length - w);
  if (baseline.length < 2) return null; // need ≥2 points for a moving range

  // σ from the baseline moving-range (subgroup size 2).
  let mrSum = 0;
  for (let i = 1; i < baseline.length; i++) {
    mrSum += Math.abs(baseline[i]! - baseline[i - 1]!);
  }
  const meanMovingRange = mrSum / (baseline.length - 1);
  const sigma = meanMovingRange / MOVING_RANGE_D2;

  // Loop-based (via bestScoreByDirection) — safe for unbounded series. `finite`
  // is non-empty here (length ≥ minRuns ≥ 2), so the result is always defined.
  const peak = bestScoreByDirection(finite, direction)!;
  const latest = finite[finite.length - 1]!;
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;

  // `drop` > 0 means the recent level is worse than the peak.
  const drop = direction === 'minimize' ? recentMean - peak : peak - recentMean;
  // σ = 0 (zero-variance baseline): any sustained drop is unambiguous signal.
  // Guard with Number.EPSILON so floating-point dust on an equal level isn't
  // mistaken for a drop.
  const nSigma = sigma === 0 ? (drop > Number.EPSILON ? Infinity : 0) : drop / sigma;

  return {
    regressed: drop > 0 && nSigma >= opts.k,
    peak,
    latest,
    recentMean,
    sigma,
    nSigma,
    baselineCount: baseline.length,
  };
}
