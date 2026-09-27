/**
 * Coach loop-health scorecard (Plan 201 §11) — dev / platform telemetry, NOT an
 * operator surface. The Coach is a platform system; its health is for the
 * developers improving it. This is the buildable-now slice computed purely from
 * `coach_activity` rows (no I/O), for regression-suite assertions + a dev
 * dashboard.
 *
 * The §11 cross-run metrics (duplicate-proposal rate, ratified-fix recurrence,
 * proposal measured lift) and the Plan-200-dependent ones (invalid-criterion
 * participation, no-suite / eval-born counts) need cross-run analysis or the
 * EvalQualityReport and land with the slow-surface + post-200 follow-up.
 *
 * @packageDocumentation
 */
import type { CoachActivityRow } from '@aflow/database';

export interface CoachScorecard {
  totalReviews: number;
  /** Reviews by terminal outcome (with_proposals / silent / observation_only / learning_only / suppressed). */
  byOutcome: Record<string, number>;
  proposalCount: number;
  observationCount: number;
  learningCount: number;
  /** Reviews that staged ≥1 proposal which failed apply-preview (an authoring-quality signal). */
  previewFailedReviews: number;
  /** previewFailedReviews / completed reviews — target ↓. */
  previewFailedRate: number;
  /** suppressed reviews / total — mostly rate-cap; a high rate means the cap is biting. */
  suppressedRate: number;
  avgCostCents: number | null;
  avgDurationMs: number | null;
}

function isCompleted(row: CoachActivityRow): boolean {
  return row.outcome !== 'suppressed';
}

export function computeCoachScorecard(rows: CoachActivityRow[]): CoachScorecard {
  const byOutcome: Record<string, number> = {};
  let proposalCount = 0;
  let observationCount = 0;
  let learningCount = 0;
  let previewFailedReviews = 0;
  let suppressed = 0;
  let costSum = 0;
  let costN = 0;
  let durSum = 0;
  let durN = 0;

  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    proposalCount += row.proposalCount;
    observationCount += row.observationCount;
    learningCount += row.learningCount;
    if (row.previewFailedCount > 0) previewFailedReviews += 1;
    if (row.outcome === 'suppressed') suppressed += 1;
    if (row.costCents !== null) {
      const c = Number(row.costCents);
      if (!Number.isNaN(c)) {
        costSum += c;
        costN += 1;
      }
    }
    if (row.durationMs !== null) {
      durSum += row.durationMs;
      durN += 1;
    }
  }

  const completed = rows.filter(isCompleted).length;

  return {
    totalReviews: rows.length,
    byOutcome,
    proposalCount,
    observationCount,
    learningCount,
    previewFailedReviews,
    previewFailedRate: completed > 0 ? previewFailedReviews / completed : 0,
    suppressedRate: rows.length > 0 ? suppressed / rows.length : 0,
    avgCostCents: costN > 0 ? costSum / costN : null,
    avgDurationMs: durN > 0 ? durSum / durN : null,
  };
}
