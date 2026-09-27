/**
 * Threshold-criterion helpers shared by the goal-progress and campaign charts.
 *
 * A numeric (`threshold`) eval criterion carries the operator's actual target
 * (`metric operator target`). Both the standalone Goal-progress card and the
 * per-campaign chart resolve their reference line from the same place, so the
 * extraction lives here rather than being duplicated per card.
 */
import type {
  CriterionResult,
  CyberneticEvalSuite,
  EvalResult,
  MaterializedThresholdCriterion,
} from '@aflow/schemas';
import { isCampaignRef } from '@aflow/schemas';

type SuiteCriterion = CyberneticEvalSuite['goalCriteria'][number];
export type ThresholdCriterion = MaterializedThresholdCriterion;

/** A threshold criterion plus how to find its result within an EvalResult. */
export interface TrackedThreshold {
  criterion: ThresholdCriterion;
  tier: string;
  pick: (result: EvalResult) => CriterionResult[];
}

/** Concrete only — a criterion whose operator/target is still a `$campaign`
 *  reference has no plottable target and is skipped. */
export function asConcreteThreshold(c: SuiteCriterion): ThresholdCriterion | null {
  if (c.type !== 'threshold') return null;
  const { operator, target } = c;
  if (isCampaignRef(operator) || isCampaignRef(target)) return null;
  return { ...c, operator, target };
}

/** Every plottable threshold in the suite, across goal / task / trajectory tiers. */
export function collectThresholds(suite: CyberneticEvalSuite | null): TrackedThreshold[] {
  if (!suite) return [];
  const out: TrackedThreshold[] = [];
  for (const c of suite.goalCriteria) {
    const t = asConcreteThreshold(c);
    if (t) out.push({ criterion: t, tier: 'Goal', pick: (r) => r.goalResults });
  }
  for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
    for (const c of criteria) {
      const t = asConcreteThreshold(c);
      if (t) {
        out.push({
          criterion: t,
          tier: `Task: ${taskId}`,
          pick: (r) => r.taskResults[taskId] ?? [],
        });
      }
    }
  }
  for (const c of suite.trajectoryCriteria) {
    const t = asConcreteThreshold(c);
    if (t) out.push({ criterion: t, tier: 'Trajectory', pick: (r) => r.trajectoryResults });
  }
  return out;
}

/**
 * The threshold whose metric a campaign is scored on (`scoreMetricKey`) — the
 * source of the campaign chart's target line. Goal-tier criteria win ties since
 * that is where a campaign's primary metric normally lives.
 */
export function findThresholdForMetric(
  suite: CyberneticEvalSuite | null,
  metricKey: string,
): ThresholdCriterion | null {
  const matches = collectThresholds(suite).filter((t) => t.criterion.metric === metricKey);
  const goalFirst = matches.find((t) => t.tier === 'Goal') ?? matches[0];
  return goalFirst?.criterion ?? null;
}

export function operatorSymbol(op: ThresholdCriterion['operator']): string {
  switch (op) {
    case 'lt':
      return '<';
    case 'lte':
      return '≤';
    case 'gt':
      return '>';
    case 'gte':
      return '≥';
    case 'eq':
      return '=';
    case 'between':
      return 'between';
  }
}

/** Whether a measured value satisfies a threshold criterion. */
export function meetsThreshold(c: ThresholdCriterion, value: number): boolean {
  switch (c.operator) {
    case 'lt':
      return value < c.target;
    case 'lte':
      return value <= c.target;
    case 'gt':
      return value > c.target;
    case 'gte':
      return value >= c.target;
    case 'eq':
      return value === c.target;
    case 'between':
      return c.targetHigh !== undefined ? value >= c.target && value <= c.targetHigh : false;
  }
}

/** Optimization direction implied by a threshold operator. */
export function directionOf(c: ThresholdCriterion): 'maximize' | 'minimize' | null {
  if (c.operator === 'gt' || c.operator === 'gte') return 'maximize';
  if (c.operator === 'lt' || c.operator === 'lte') return 'minimize';
  return null;
}

/**
 * The raw measured value for a threshold criterion result. Prefers the
 * dedicated `observedValue` field; for runs graded before that field existed,
 * recovers the number from the grader's evidence string (`<metric> = <value>`),
 * whose format we own.
 */
export function observedValue(cr: CriterionResult): number | null {
  if (typeof cr.observedValue === 'number') return cr.observedValue;
  const match = cr.evidence?.match(/=\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i);
  return match ? Number(match[1]) : null;
}
