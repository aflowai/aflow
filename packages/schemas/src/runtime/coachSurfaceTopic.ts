import { z } from 'zod';
import { AnomalyReportSchema } from '../cybernetic/anomalyReport.js';
import {
  ActiveSurfaceCoachSchema,
  ActiveSurfaceHelmsmanSchema,
  ActiveSurfaceRunSchema,
  ActiveSurfaceTransitionSchema,
} from '../cybernetic/activeSurface.js';

// ============================================================================
// Topic subscribe
// ============================================================================

export const SpaceCoachSurfaceTopicSchema = z.object({
  kind: z.literal('space.coach_surface'),
  spaceId: z.string().uuid(),
});
export type SpaceCoachSurfaceTopic = z.infer<typeof SpaceCoachSurfaceTopicSchema>;

// ============================================================================
// Anomaly summary (matches the REST `/anomalies` row shape)
// ============================================================================

/**
 * Compact anomaly row carried in the topic's snapshot + `anomaly_added`
 * deltas. Subset of `AnomalyReportSchema` matching the REST list
 * endpoint's projection (`packages/server-runtime/src/routes/cybernetic/anomalies.ts`).
 */
export const CoachAnomalySummarySchema = z.object({
  id: AnomalyReportSchema.shape.id,
  kind: AnomalyReportSchema.shape.kind,
  severity: AnomalyReportSchema.shape.severity,
  summary: AnomalyReportSchema.shape.summary,
  reportedAt: AnomalyReportSchema.shape.reportedAt,
  acknowledged: z.boolean(),
  acknowledgedBy: AnomalyReportSchema.shape.acknowledgedBy,
  acknowledgedAt: AnomalyReportSchema.shape.acknowledgedAt,
  coachSessionId: AnomalyReportSchema.shape.coachSessionId,
  relatedStagedChangeId: AnomalyReportSchema.shape.relatedStagedChangeId,
});
export type CoachAnomalySummary = z.infer<typeof CoachAnomalySummarySchema>;

// ============================================================================
// Snapshot envelope (emitted once per subscribe)
// ============================================================================

export const CoachSurfaceSnapshotSchema = z.object({
  coach: ActiveSurfaceCoachSchema,
  anomalies: z.array(CoachAnomalySummarySchema),
  helmsman: ActiveSurfaceHelmsmanSchema,
  surfacedRuns: z.array(ActiveSurfaceRunSchema),
  recentTransitions: z.array(ActiveSurfaceTransitionSchema),
});
export type CoachSurfaceSnapshot = z.infer<typeof CoachSurfaceSnapshotSchema>;

// ============================================================================
// Deltas
// ============================================================================

export const CoachSurfaceDeltaSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lifecycle'),
    coach: ActiveSurfaceCoachSchema,
  }),
  z.object({
    kind: z.literal('anomaly_added'),
    anomaly: CoachAnomalySummarySchema,
  }),
  z.object({
    kind: z.literal('anomaly_resolved'),
    anomalyId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('surfaced_runs'),
    surfacedRuns: z.array(ActiveSurfaceRunSchema),
  }),
  z.object({
    kind: z.literal('helmsman'),
    helmsman: ActiveSurfaceHelmsmanSchema,
  }),
  z.object({
    kind: z.literal('transitions'),
    recentTransitions: z.array(ActiveSurfaceTransitionSchema),
  }),
]);
export type CoachSurfaceDelta = z.infer<typeof CoachSurfaceDeltaSchema>;
