import type { DirectiveLearningPolicy, SkillMaturity } from '@aflow/schemas';

// ============================================================================
// Inputs
// ============================================================================

export interface SkillMaturityStats {
  /** Completed runs in the reconciler's stats window. */
  completedRuns: number;
  /**
   * Consecutive terminal successes, newest first (a failed/cancelled run
   * resets the streak; non-terminal runs are skipped).
   */
  consecutiveSuccesses: number;
  /**
   * True when a regression is currently standing: a confirmed eval-baseline
   * breach streak, or the campaign trajectory's σ-band regression-from-peak.
   */
  recentRegression: boolean;
}

export interface SkillMaturityKnobs {
  /** Run count below which the skill is `adhoc` (= `skillMaturityRunsThreshold`). */
  practisingRunsFloor: number;
  /** Completed-run floor for `mastered`. */
  masteredRunsFloor: number;
  /** Consecutive-success streak required for `mastered`. */
  masteredConsecutiveSuccesses: number;
}

/** Map the learningPolicy knobs (schema defaults applied) to the derivation knobs. */
export function resolveSkillMaturityKnobs(
  policy: DirectiveLearningPolicy | undefined,
): SkillMaturityKnobs {
  return {
    practisingRunsFloor: policy?.skillMaturityRunsThreshold ?? 5,
    masteredRunsFloor: policy?.skillMaturityDerivation.masteredRunsFloor ?? 10,
    masteredConsecutiveSuccesses: policy?.skillMaturityDerivation.masteredConsecutiveSuccesses ?? 5,
  };
}

// ============================================================================
// Derivation (pure)
// ============================================================================

/**
 * Derive the skill's maturity level from run stats. Pure + deterministic:
 * same stats + same knobs ⇒ same level, always.
 */
export function deriveSkillMaturity(
  stats: SkillMaturityStats,
  knobs: SkillMaturityKnobs,
): SkillMaturity {
  if (stats.completedRuns < knobs.practisingRunsFloor) return 'adhoc';
  if (
    stats.completedRuns >= knobs.masteredRunsFloor &&
    stats.consecutiveSuccesses >= knobs.masteredConsecutiveSuccesses &&
    !stats.recentRegression
  ) {
    return 'mastered';
  }
  return 'practising';
}

// ============================================================================
// Transition (pure)
// ============================================================================

export interface SkillMaturityTransition {
  from: SkillMaturity;
  to: SkillMaturity;
}

/**
 * A transition exists only when a PRIOR persisted level differs from the
 * derived one. First-ever projections (no prior) never emit — the bootstrap
 * window already owns first-runs attention, and a synthetic
 * `practising → adhoc` flap on legacy projections would be noise.
 */
export function computeMaturityTransition(
  prior: SkillMaturity | undefined,
  next: SkillMaturity,
): SkillMaturityTransition | null {
  if (prior === undefined || prior === next) return null;
  return { from: prior, to: next };
}

/**
 * Count consecutive terminal successes from a newest-first run-status list.
 * Non-terminal statuses (`running`, `paused`) are skipped — they say nothing
 * about the streak; `failed` / `cancelled` ends it.
 */
export function countConsecutiveSuccesses(newestFirstStatuses: readonly string[]): number {
  let streak = 0;
  for (const status of newestFirstStatuses) {
    if (status === 'running' || status === 'paused') continue;
    if (status === 'completed') {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}
