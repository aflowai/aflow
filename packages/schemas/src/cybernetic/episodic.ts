import { z } from 'zod';

// ============================================================================
// Episodic Entry
// ============================================================================

/** A workflow activation during an interaction. */
export const WorkflowActivationSchema = z.object({
  /** Workflow slug. */
  slug: z.string().max(64),
  /** Run ID (if a workflow run was created). */
  runId: z.string().uuid().optional(),
  /** Outcome of the workflow activation. */
  outcome: z.enum(['completed', 'failed', 'paused', 'partial']).optional(),
});

/**
 * A single episodic memory entry — a summary of one interaction.
 * Stored at `/interactions/{YYYY}/{MM}/{id}.json`.
 */
export const EpisodicEntrySchema = z.object({
  /** Unique entry ID (matches the filename without extension). */
  id: z.string().uuid(),
  /** Summary of the interaction in 2-4 sentences. */
  summary: z.string().max(1000),
  /** Key decisions made or outcomes reached. */
  decisions: z.array(z.string().max(300)).max(10).default([]),
  /** Topics discussed (for search/clustering). */
  topics: z.array(z.string().max(100)).max(15).default([]),
  /** Emotional/relational tone (helps the entity recall interaction quality). */
  tone: z.enum(['routine', 'positive', 'frustrated', 'urgent', 'exploratory']).optional(),
  /** User who initiated the interaction (null for background/scheduled). */
  userId: z.string().max(256).optional(),
  /** Display name at time of interaction (for readability). */
  userName: z.string().max(256).optional(),
  /** Operating modes used during this interaction. */
  modesUsed: z
    .array(z.enum(['conversational', 'exploratory', 'procedural', 'supervisory']))
    .default([]),
  /** Workflows activated (if any). */
  workflowsActivated: z.array(WorkflowActivationSchema).max(10).default([]),
  /** Session IDs involved (for drill-down in operator view). */
  sessionIds: z.array(z.string().uuid()).max(20).default([]),
  /** When the interaction started. */
  startedAt: z.string().datetime(),
  /** When the interaction ended. */
  endedAt: z.string().datetime().optional(),
  /** Cost of the interaction in cents (for budget tracking). */
  costCents: z.number().nonnegative().optional(),
  /** Total tokens consumed. */
  totalTokens: z.number().int().nonnegative().optional(),
  /** Consolidation status: raw entries get summarized into weekly/monthly digests. */
  consolidationStatus: z.enum(['raw', 'summarized', 'archived']).default('raw'),
});

export type EpisodicEntry = z.infer<typeof EpisodicEntrySchema>;
