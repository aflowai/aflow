import type { EvalCriterion, CriterionResult } from '@aflow/schemas';
import { compareWithThresholdOperator, isCampaignRef } from '@aflow/schemas';

export const CONTAINS_RESERVED_FIELDS: ReadonlySet<string> = new Set(['summary']);

export function evaluateCriterion(
  criterion: EvalCriterion,
  data: {
    metrics?: Record<string, unknown>;
    /**
     * Task output (taskCriteria scope only — populated from the task row's
     * decoded outputRef). When set, `contains` / `threshold` field lookups
     * read from `output` BEFORE falling back to `metrics`, because the
     * agent's natural write surface is the output schema, not a separate
     * metrics dict.
     */
    output?: Record<string, unknown>;
    summary?: string;
    aggregateMetrics?: {
      stepCount: number;
      durationMs: number;
      costCents: number;
    };
  },
): CriterionResult | null {
  // Resolve a named field with output-first preference: agents write to
  // outputs (via submit_output), not metrics. For taskCriteria we want
  // `output.validationScore` to satisfy `inField: 'validationScore'`. For
  // goal/trajectory criteria where only `metrics` is populated, the fallback
  // preserves prior behavior. `null` is treated as "not present" so an
  // explicitly null output field falls through to metrics rather than
  // shadowing it.
  const resolveField = (name: string): unknown => {
    if (data.output !== undefined) {
      const fromOutput = data.output[name];
      if (fromOutput !== undefined && fromOutput !== null) return fromOutput;
    }
    return data.metrics?.[name];
  };

  switch (criterion.type) {
    case 'threshold': {
      const { operator, target } = criterion;
      if (isCampaignRef(operator) || isCampaignRef(target)) {
        return {
          criterionName: criterion.name,
          criterionType: 'threshold',
          passed: false,
          applicable: false,
          evidence:
            'Criterion carries unresolved $campaign reference(s) — campaign-parameterized ' +
            'criteria must be resolved against the run campaign config before evaluation',
        };
      }

      const metricValue = resolveField(criterion.metric);
      if (metricValue === undefined || typeof metricValue !== 'number') {
        return {
          criterionName: criterion.name,
          criterionType: 'threshold',
          passed: false,
          applicable: false,
          evidence: `Metric '${criterion.metric}' not found or not numeric`,
        };
      }

      const passed = compareWithThresholdOperator(
        metricValue,
        operator,
        target,
        criterion.targetHigh,
      );

      return {
        criterionName: criterion.name,
        criterionType: 'threshold',
        passed,
        score: passed ? 1 : 0,
        observedValue: metricValue,
        evidence: `${criterion.metric} = ${String(metricValue)} (${operator} ${String(target)}${operator === 'between' ? ` - ${String(criterion.targetHigh)}` : ''})`,
      };
    }

    case 'contains': {
      // Check for the pattern in the specified field
      let fieldValue: string | undefined;
      if (CONTAINS_RESERVED_FIELDS.has(criterion.inField)) {
        // Reserved field → the task's prose summary string (the only member
        // today). Kept in lockstep with CONTAINS_RESERVED_FIELDS so the static
        fieldValue = data.summary;
      } else {
        const val = resolveField(criterion.inField);
        fieldValue =
          typeof val === 'string' ? val : val !== undefined ? JSON.stringify(val) : undefined;
      }

      if (fieldValue === undefined) {
        return {
          criterionName: criterion.name,
          criterionType: 'contains',
          passed: false,
          applicable: false,
          evidence: `Field '${criterion.inField}' not found`,
        };
      }

      let passed: boolean;
      try {
        const regex = new RegExp(criterion.pattern);
        passed = regex.test(fieldValue);
      } catch {
        // Fall back to exact substring match if regex is invalid
        passed = fieldValue.includes(criterion.pattern);
      }

      return {
        criterionName: criterion.name,
        criterionType: 'contains',
        passed,
        score: passed ? 1 : 0,
        evidence: `Field '${criterion.inField}' ${passed ? 'matches' : 'does not match'} pattern '${criterion.pattern}'`,
      };
    }

    case 'trace_bound': {
      const agg = data.aggregateMetrics;
      if (!agg) {
        return {
          criterionName: criterion.name,
          criterionType: 'trace_bound',
          passed: false,
          applicable: false,
          evidence: 'No aggregate trace metrics available',
        };
      }

      let actualValue: number;
      switch (criterion.metric) {
        case 'step_count':
          actualValue = agg.stepCount;
          break;
        case 'duration_ms':
          actualValue = agg.durationMs;
          break;
        case 'cost_cents':
          actualValue = agg.costCents;
          break;
        case 'token_count':
          // Token count not directly tracked in task results — skip
          return {
            criterionName: criterion.name,
            criterionType: 'trace_bound',
            passed: true,
            evidence: 'Token count tracking not available — skipped (pass by default)',
          };
        case 'tool_call_count':
          actualValue = agg.stepCount; // Approximate with step count
          break;
      }

      const passed = actualValue <= criterion.maxValue;
      return {
        criterionName: criterion.name,
        criterionType: 'trace_bound',
        passed,
        score: passed ? 1 : 0,
        evidence: `${criterion.metric} = ${String(actualValue)} (max: ${String(criterion.maxValue)})`,
      };
    }

    case 'judge':
      // Tier 3 — handled async by evaluateJudgeCriterion (104e §4.3).
      // Return null here; the main loop calls evaluateJudgeCriterion separately.
      return null;

    default:
      return null;
  }
}
