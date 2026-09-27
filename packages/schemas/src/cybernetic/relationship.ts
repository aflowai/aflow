import { z } from 'zod';

// ============================================================================
// User Relationship
// ============================================================================

/** Communication preferences the entity has learned for a user. */
export const UserPreferencesSchema = z.object({
  /** Preferred verbosity: concise, standard, detailed. */
  verbosity: z.enum(['concise', 'standard', 'detailed']).default('standard'),
  /** Preferred response format. */
  format: z.enum(['prose', 'structured', 'mixed']).default('mixed'),
  /** Topics this user frequently asks about. */
  frequentTopics: z.array(z.string().max(100)).max(20).default([]),
  /** Free-form preference notes. */
  notes: z.array(z.string().max(300)).max(10).default([]),
});

/** Interaction statistics for a user. */
export const UserInteractionStatsSchema = z.object({
  /** Total number of interactions with this user. */
  totalInteractions: z.number().int().nonnegative().default(0),
  /** When the last interaction with this user occurred. */
  lastInteractionAt: z.string().datetime().optional(),
  /** When the first interaction with this user occurred. */
  firstInteractionAt: z.string().datetime().optional(),
});

/** A recent interaction reference for quick context. */
export const RecentInteractionRefSchema = z.object({
  /** ID of the episodic entry for this interaction. */
  episodicEntryId: z.string().uuid(),
  /** When the interaction occurred. */
  date: z.string().datetime(),
  /** Brief summary of the interaction. */
  summary: z.string().max(200),
});

/**
 * Per-user relationship memory for a cybernetic entity.
 * Stored at `/relationships/{userId}/profile.json`.
 *
 * Each user has their own relationship profile. The entity reads the active
 * user's profile at the start of each interaction and adapts accordingly.
 * Skills and knowledge are shared across all users.
 */
export const UserRelationshipSchema = z.object({
  /** Schema version. */
  version: z.literal(1),
  /** Internal user ID (Phoenix UUID). */
  userId: z.string().uuid(),
  /** Display name (cached from last interaction). */
  displayName: z.string().max(256).optional(),
  /** User's role in the tenant (cached: admin, member, viewer). */
  role: z.string().max(64).optional(),
  /** Communication preferences the entity has learned for this user. */
  preferences: UserPreferencesSchema.default({}),
  /** Interaction statistics. */
  stats: UserInteractionStatsSchema.default({}),
  /** Recent interaction references (last N, for quick context). */
  recentInteractions: z.array(RecentInteractionRefSchema).max(20).default([]),
  /** Trust/familiarity level (entity's internal model of the relationship). */
  familiarity: z.enum(['new', 'familiar', 'established']).default('new'),
  /** When this relationship profile was last updated. */
  updatedAt: z.string().datetime(),
});

export type UserRelationship = z.infer<typeof UserRelationshipSchema>;
