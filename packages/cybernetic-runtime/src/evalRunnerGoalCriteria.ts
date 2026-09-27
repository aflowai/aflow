import type { CyberneticEvalSuite, CriterionResult } from '@aflow/schemas';
import { evaluateCriterion } from './evalRunnerCriterion.js';

export function buildGoalMetrics(params: {
  runLevelMetrics?: Record<string, unknown> | undefined;
  outcomeResults?:
    | {
        met: number;
        total: number;
        details: Array<{ outcomeId: string; met: boolean }>;
      }
    | undefined;
}): Record<string, unknown> {
  const { runLevelMetrics, outcomeResults } = params;
  return {
    ...(runLevelMetrics ?? {}),
    ...(outcomeResults
      ? {
          outcomes_met: outcomeResults.met,
          outcomes_total: outcomeResults.total,
          outcomes_ratio: outcomeResults.total > 0 ? outcomeResults.met / outcomeResults.total : 0,
        }
      : {}),
  };
}

export function evaluateGoalCriteria(params: {
  suite: CyberneticEvalSuite;
  goalMetrics: Record<string, unknown>;
  outcomeResults?:
    | {
        met: number;
        total: number;
        details: Array<{ outcomeId: string; met: boolean }>;
      }
    | undefined;
  aggregateMetrics: { stepCount: number; durationMs: number; costCents: number };
}): CriterionResult[] {
  const { suite, goalMetrics, outcomeResults, aggregateMetrics } = params;
  const goalResults: CriterionResult[] = [];
  for (const criterion of suite.goalCriteria) {
    if (criterion.type === 'contains' && outcomeResults) {
      const detailsStr = JSON.stringify(outcomeResults.details);
      const result = evaluateCriterion(criterion, {
        summary: detailsStr,
        metrics: { ...goalMetrics, details: detailsStr },
      });
      if (result) goalResults.push(result);
    } else {
      const result = evaluateCriterion(criterion, {
        metrics: goalMetrics,
        aggregateMetrics,
      });
      if (result) goalResults.push(result);
    }
  }
  return goalResults;
}
