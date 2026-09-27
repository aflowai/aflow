import type { EvalCriterion } from './eval.js';

export interface EvalDisciplineIssue {
  code: 'judge_without_deterministic_anchor' | 'judge_primary_score';
  detail: string;
}

/** The structural sub-shape the discipline rules need (full suites satisfy it). */
export interface EvalSuiteDisciplineInput {
  goalCriteria: readonly EvalCriterion[];
  taskCriteria: Readonly<Record<string, readonly EvalCriterion[]>>;
  trajectoryCriteria: readonly EvalCriterion[];
  weights: { goal: number; task: number; trajectory: number };
}

const DETERMINISTIC_TYPES = new Set(['threshold', 'contains', 'trace_bound']);

function isDeterministic(c: EvalCriterion): boolean {
  return DETERMINISTIC_TYPES.has(c.type);
}

function isJudge(c: EvalCriterion): boolean {
  return c.type === 'judge';
}

/**
 * Validate the determinism-first + judge-non-primary rules over a suite.
 * Pure; returns [] for a disciplined suite.
 */
export function validateEvalSuiteDiscipline(
  suite: EvalSuiteDisciplineInput,
): EvalDisciplineIssue[] {
  const issues: EvalDisciplineIssue[] = [];

  const taskAll = Object.values(suite.taskCriteria).flat();
  const tiers: Array<{
    name: 'goal' | 'task' | 'trajectory';
    criteria: readonly EvalCriterion[];
    weight: number;
  }> = [
    { name: 'goal', criteria: suite.goalCriteria, weight: suite.weights.goal },
    { name: 'task', criteria: taskAll, weight: suite.weights.task },
    { name: 'trajectory', criteria: suite.trajectoryCriteria, weight: suite.weights.trajectory },
  ];

  const allCriteria = tiers.flatMap((t) => [...t.criteria]);
  const hasJudge = allCriteria.some(isJudge);
  if (!hasJudge) return issues;

  // Rule 1 — determinism-first admission.
  const hasDeterministicAnywhere = allCriteria.some(isDeterministic);
  if (!hasDeterministicAnywhere) {
    issues.push({
      code: 'judge_without_deterministic_anchor',
      detail:
        'The suite contains judge criteria but no deterministic criterion (threshold / contains / ' +
        'trace_bound). An uncalibrated judge cannot anchor its own grading — add at least one ' +
        'deterministic criterion before admitting a judge.',
    });
  }

  // Rule 2a — a tier whose criteria are all judge must be advisory (weight 0).
  for (const tier of tiers) {
    if (tier.criteria.length === 0 || tier.weight === 0) continue;
    if (tier.criteria.every(isJudge)) {
      issues.push({
        code: 'judge_primary_score',
        detail:
          `The ${tier.name} tier carries weight ${String(tier.weight)} but consists solely of judge ` +
          'criteria. An uncalibrated judge may be secondary/advisory but never the primary score — ' +
          'set the tier weight to 0 (advisory) or add a deterministic criterion to the tier.',
      });
    }
  }

  // Rule 2b — deterministic criteria must carry score weight SOMEWHERE.
  // Without this, deterministic anchors parked in a 0-weight tier leave the
  // overall score judge-steered.
  const deterministicCarriesWeight = tiers.some(
    (t) => t.weight > 0 && t.criteria.some(isDeterministic),
  );
  if (hasDeterministicAnywhere && !deterministicCarriesWeight) {
    issues.push({
      code: 'judge_primary_score',
      detail:
        'Every deterministic criterion sits in a 0-weight tier, so the overall score is steered by ' +
        'judge criteria alone. Give a tier containing a deterministic criterion non-zero weight.',
    });
  }

  return issues;
}
