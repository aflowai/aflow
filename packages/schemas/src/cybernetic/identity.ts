import { z } from 'zod';

// ============================================================================
// Entity Self-Model
// ============================================================================

/** A behavioral pattern the entity has developed through experience. */
export const BehavioralPatternSchema = z.object({
  /** Description of the behavioral pattern. */
  pattern: z.string().max(300),
  /** When this pattern was last reinforced by evidence. */
  lastReinforced: z.string().datetime().optional(),
  /** Confidence level in this pattern. */
  confidence: z.enum(['tentative', 'established', 'core']),
});

/** Communication style the entity has converged on. */
export const CommunicationStyleSchema = z.object({
  /** Natural-language description of the entity's communication style. */
  description: z.string().max(500).optional(),
  /** Notes about vocabulary choices, phrasing preferences, etc. */
  vocabularyNotes: z.array(z.string().max(200)).max(20).default([]),
});

/** A domain expertise area, derived from workflow/learning counts. */
export const ExpertiseAreaSchema = z.object({
  /** Domain name. */
  domain: z.string().max(200),
  /** Evidence: workflow slugs and learning counts that support this claim. */
  evidence: z.array(z.string().max(128)).max(10).default([]),
});

/** Clone provenance — present if this entity was cloned from another. */
export const CloneProvenanceSchema = z.object({
  /** Source space ID. */
  spaceId: z.string().uuid(),
  /** Source space name at time of cloning. */
  spaceName: z.string().max(200),
  /** When the clone was performed. */
  clonedAt: z.string().datetime(),
});

/**
 * Self-model for a cybernetic entity.
 * Stored as a memory document at `/identity/self-model.json`.
 *
 * Contains only emergent identity — things the entity discovers through experience.
 * No `role` field: role = `directives.scope.responsibility` (constitutional).
 */
export const EntitySelfModelSchema = z.object({
  /** Schema version. */
  version: z.literal(1),
  /** Behavioral patterns the entity has developed. */
  behavioralPatterns: z.array(BehavioralPatternSchema).max(30).default([]),
  /** Communication style the entity has converged on. */
  communicationStyle: CommunicationStyleSchema.default({}),
  /** Domain expertise areas — advisory, derived from workflow/learning counts. */
  expertiseAreas: z.array(ExpertiseAreaSchema).max(20).default([]),
  /** When the self-model was first created. */
  createdAt: z.string().datetime(),
  /** When the self-model was last updated. */
  updatedAt: z.string().datetime(),
  /** Who last updated the self-model (agentId, 'operator', or 'system'). */
  lastUpdatedBy: z.string().max(64),
  /** Clone provenance (if entity was cloned from another). */
  clonedFrom: CloneProvenanceSchema.optional(),
});

export type EntitySelfModel = z.infer<typeof EntitySelfModelSchema>;
