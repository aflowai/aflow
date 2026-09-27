import { z } from 'zod';

// ============================================================================
// Anomaly Kind & Severity
// ============================================================================

/** Classification of the anomaly. */
export const AnomalyKindSchema = z.enum([
  'repeated_failure', // Workflow failing N times consecutively
  'performance_degradation', // Outcome scores trending downward
  'cost_anomaly', // Run cost significantly above historical average
  'configuration_error', // Wrong tools provided, bad context assembly
  'external_dependency', // External API down, rate limited, data unavailable
  'stale_procedure', // Workflow hasn't been activated in decay window
  'platform_issue', // Tool returned error, infrastructure failure
]);

export type AnomalyKind = z.infer<typeof AnomalyKindSchema>;

/** How urgent is this anomaly. */
export const AnomalySeveritySchema = z.enum([
  'info', // Notable but not actionable
  'warning', // Should be reviewed
  'critical', // Requires immediate attention
]);

export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;

// ============================================================================
// Anomaly Report Schema
// ============================================================================

/**
 * An anomaly report produced by the Learner during artifact review.
 *
 * The Learner observes and reports -- it does not prescribe actions.
 * The Executive or operator decides what action to take based on the report.
 * suggestedRemediation is free-form advice, not a prescriptive action enum.
 */
export const AnomalyReportSchema = z.object({
  /** Unique identifier for this anomaly report. */
  id: z.string().uuid(),

  /** Classification of the anomaly. */
  kind: AnomalyKindSchema,

  /** How urgent this anomaly is. */
  severity: AnomalySeveritySchema,

  /** Human-readable summary of the anomaly. */
  summary: z.string().max(500),

  /** Detailed description of what was observed. */
  detail: z.string().max(2000),

  /** Affected workflow slug, if applicable. */
  affectedWorkflowSlug: z.string().optional(),

  /** Affected task ID within the workflow, if applicable. */
  affectedTaskId: z.string().optional(),

  /** Evidence supporting this anomaly report. */
  evidence: z.object({
    /** Session IDs where the anomaly was observed. */
    sessionIds: z.array(z.string().uuid()),
    /** Arbitrary metrics supporting the report. */
    metrics: z.record(z.string(), z.unknown()).optional(),
    /** Trend data showing direction of change. */
    trend: z
      .object({
        /** Which metric is trending. */
        metric: z.string(),
        /** Recent values (chronological order). */
        values: z.array(z.number()),
        /** Direction of the trend. */
        direction: z.enum(['improving', 'degrading', 'stable']),
      })
      .optional(),
  }),

  /** Free-form remediation advice (the Learner observes, doesn't prescribe). */
  suggestedRemediation: z.string().max(500).optional(),

  /** If a related staged change proposal exists. */
  relatedStagedChangeId: z.string().uuid().optional(),

  /** When this anomaly was reported (ISO 8601). */
  reportedAt: z.string().datetime(),

  /** The Coach session that produced this report. */
  coachSessionId: z.string().uuid(),

  /** Whether an operator has acknowledged this anomaly. */
  acknowledged: z.boolean().default(false),

  /** Who acknowledged the anomaly. */
  acknowledgedBy: z.string().optional(),

  /** When the anomaly was acknowledged (ISO 8601). */
  acknowledgedAt: z.string().datetime().optional(),
});

export type AnomalyReport = z.infer<typeof AnomalyReportSchema>;
