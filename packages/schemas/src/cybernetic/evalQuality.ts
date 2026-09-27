import { z } from 'zod';
import type { CriterionResult, CyberneticEvalSuite, EvalResult } from './eval.js';

/**
 * Criterion-result types that carry no verdict on the SKILL: `judge_error`
 * (the judge infrastructure failed) and `judge_skipped` (the dispatch was
 * refused — judge model equals the subject, or the subject models could not
 * be resolved). Every scoring/fault/quality aggregation excludes them
 * through this one set — a measurement defect must never read as a 0/fail.
 * Lives here, not in eval.ts, because eval.ts imports this module at
 * runtime and a value import back would cycle.
 */
export const NON_SCORABLE_CRITERION_TYPES: ReadonlySet<string> = new Set([
  'judge_error',
  'judge_skipped',
]);

// ============================================================================
// Schema
// ============================================================================

export const EvalQualityCriterionStatSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** `goal` | `task:<taskId>` | `trajectory` — where the criterion lives in the suite. */
    tier: z.string().min(1).max(220),
    /** Evaluated samples in the examined window (judge_error excluded). */
    samples: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    /** True when samples ≥ minSamples AND every sample passed. */
    alwaysPasses: z.boolean(),
  })
  .strict();
export type EvalQualityCriterionStat = z.infer<typeof EvalQualityCriterionStatSchema>;

export const EvalQualityReportSchema = z
  .object({
    computedAt: z.string().datetime(),
    /** How many recent eval results were examined. */
    sampleSize: z.number().int().nonnegative(),
    /** The knob value the flags were computed against. */
    minSamples: z.number().int().min(2),
    /** Per-criterion stats for every suite criterion seen in ≥1 result. */
    criteria: z.array(EvalQualityCriterionStatSchema).max(50),
  })
  .strict();
export type EvalQualityReport = z.infer<typeof EvalQualityReportSchema>;

// ============================================================================
// Deterministic compute (pure)
// ============================================================================

function collectResults(result: EvalResult): Array<{ tier: string; r: CriterionResult }> {
  return [
    ...result.goalResults.map((r) => ({ tier: 'goal', r })),
    ...Object.entries(result.taskResults).flatMap(([taskId, arr]) =>
      arr.map((r) => ({ tier: `task:${taskId}`, r })),
    ),
    ...result.trajectoryResults.map((r) => ({ tier: 'trajectory', r })),
  ];
}

/**
 * Compute the quality report over a suite + its recent eval results.
 * Deterministic; matches result rows to suite criteria by (tier, name).
 * Criteria the suite no longer declares are not reported (a removed
 * criterion's history is moot).
 */
export function computeEvalQualityReport(
  suite: Pick<CyberneticEvalSuite, 'goalCriteria' | 'taskCriteria' | 'trajectoryCriteria'>,
  recentResults: readonly EvalResult[],
  opts: { minSamples: number },
): EvalQualityReport {
  const declared = new Map<string, { name: string; tier: string }>();
  for (const c of suite.goalCriteria)
    declared.set(`goal\u0000${c.name}`, { name: c.name, tier: 'goal' });
  for (const [taskId, arr] of Object.entries(suite.taskCriteria)) {
    for (const c of arr) {
      declared.set(`task:${taskId}\u0000${c.name}`, { name: c.name, tier: `task:${taskId}` });
    }
  }
  for (const c of suite.trajectoryCriteria) {
    declared.set(`trajectory\u0000${c.name}`, { name: c.name, tier: 'trajectory' });
  }

  const stats = new Map<string, { samples: number; passes: number }>();
  for (const result of recentResults) {
    if (result.verdict === 'error') continue;
    for (const { tier, r } of collectResults(result)) {
      if (NON_SCORABLE_CRITERION_TYPES.has(r.criterionType)) continue;
      const key = `${tier}\u0000${r.criterionName}`;
      if (!declared.has(key)) continue;
      const entry = stats.get(key) ?? { samples: 0, passes: 0 };
      entry.samples += 1;
      if (r.passed) entry.passes += 1;
      stats.set(key, entry);
    }
  }

  const criteria: EvalQualityCriterionStat[] = [];
  for (const [key, meta] of declared) {
    const s = stats.get(key);
    if (!s || s.samples === 0) continue;
    criteria.push({
      name: meta.name,
      tier: meta.tier,
      samples: s.samples,
      passes: s.passes,
      alwaysPasses: s.samples >= opts.minSamples && s.passes === s.samples,
    });
    if (criteria.length >= 50) break;
  }

  return {
    computedAt: new Date().toISOString(),
    sampleSize: recentResults.length,
    minSamples: opts.minSamples,
    criteria,
  };
}
