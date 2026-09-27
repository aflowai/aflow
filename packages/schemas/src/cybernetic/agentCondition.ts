import { z } from 'zod';

// ============================================================================
// Trace-derived axes (183d §4.2) — computed by the harness, never asked
// ============================================================================

export const AgentProgressSchema = z.enum(['advancing', 'stalled']);
export type AgentProgress = z.infer<typeof AgentProgressSchema>;

export const AgentComplexitySchema = z.enum(['routine', 'involved', 'sprawling']);
export type AgentComplexity = z.infer<typeof AgentComplexitySchema>;

/**
 * The raw trace inputs the harness derives `progress` + `complexity` from.
 * Only fields with a consumer (the derivation itself + the §5.4 replay test)
 * are carried — duration/token bucketing is added only if real-run evidence
 * shows step counts are insufficient.
 */
export const AgentConditionTraceMetricsSchema = z.object({
  /** Tool/step executions observed in the session (StepScheduled count). */
  stepCount: z.number().int().nonnegative(),
  /** Failed step executions observed in the session (StepFailed count). */
  failedStepCount: z.number().int().nonnegative(),
});
export type AgentConditionTraceMetrics = z.infer<typeof AgentConditionTraceMetricsSchema>;

export interface AgentConditionDerivationPolicy {
  /** Step count at or above which derived complexity is `involved`. */
  involvedStepFloor: number;
  /** Step count at or above which derived complexity is `sprawling`. */
  sprawlingStepFloor: number;
  /** Failed-step fraction at or above which derived progress is `stalled`. */
  stalledFailureRatio: number;
}

export function deriveAgentComplexity(
  metrics: AgentConditionTraceMetrics,
  policy: AgentConditionDerivationPolicy,
): AgentComplexity {
  if (metrics.stepCount >= policy.sprawlingStepFloor) return 'sprawling';
  if (metrics.stepCount >= policy.involvedStepFloor) return 'involved';
  return 'routine';
}

export function deriveAgentProgress(
  metrics: AgentConditionTraceMetrics,
  policy: AgentConditionDerivationPolicy,
): AgentProgress {
  if (
    metrics.stepCount > 0 &&
    metrics.failedStepCount / metrics.stepCount >= policy.stalledFailureRatio
  ) {
    return 'stalled';
  }
  return 'advancing';
}

// ============================================================================
// Computed headline (183d §4.3)
// ============================================================================

export const AgentDispositionSchema = z.enum(['steady', 'struggling']);
export type AgentDisposition = z.infer<typeof AgentDispositionSchema>;

export interface AgentConditionAxes {
  progress: AgentProgress;
  complexity: AgentComplexity;
}

/**
 * Disposition: `struggling` when stalled on a routine task (effort disproportionate
 * to task warrant); `steady` otherwise.
 */
export function computeAgentDisposition(axes: AgentConditionAxes): AgentDisposition {
  if (axes.progress === 'stalled' && axes.complexity === 'routine') return 'struggling';
  return 'steady';
}

// ============================================================================
// The persisted condition record
// ============================================================================

/**
 * The full condition as persisted beside the reflection on the task row and
 * on the `entity.runner.reflection` event. Trace-derived axes + the computed
 * headline + the raw trace metrics (so the derivation is replayable).
 */
export const AgentConditionSchema = z.object({
  progress: AgentProgressSchema,
  complexity: AgentComplexitySchema,
  disposition: AgentDispositionSchema,
  trace: AgentConditionTraceMetricsSchema,
});
export type AgentCondition = z.infer<typeof AgentConditionSchema>;

/** Build the full condition record from trace metrics alone. */
export function buildAgentCondition(
  metrics: AgentConditionTraceMetrics,
  policy: AgentConditionDerivationPolicy,
): AgentCondition {
  const progress = deriveAgentProgress(metrics, policy);
  const complexity = deriveAgentComplexity(metrics, policy);
  return {
    progress,
    complexity,
    disposition: computeAgentDisposition({ progress, complexity }),
    trace: metrics,
  };
}
