import { z } from 'zod';

// ============================================================================
// Ad-Hoc Grant Policy
// ============================================================================

/**
 * Operations that the Helmsman may always grant to an ad-hoc Runner capsule
 * without additional policy gating.
 */
export const ADHOC_ALWAYS_GRANTABLE = [
  'compute.sandbox.exec',
  'memory.store.query',
  'memory.store.get',
  'memory.store.put',
  'workflow.learn',
  'workflow.ledger.get',
] as const;

/**
 * Operations that require explicit space-level policy enablement before
 * the Helmsman may grant them ad-hoc. These are enabled per-space via
 * the AdHocGrantPolicy configuration.
 */
export const ADHOC_POLICY_GATED = [
  'ai.text.generate',
  'ai.text.generate_json',
  'ai.media.image',
  'ai.media.edit_image',
  'ai.media.video',
] as const;

/**
 * Operations that are NEVER grantable ad-hoc — they require a formal skill.
 * The delegate handler rejects these in ad-hoc capsule context.
 */
export const ADHOC_NEVER_GRANTABLE = [
  'api.http.call',
  'agent.manage.create',
  'agent.manage.update',
  'agent.manage.delete',
] as const;

/**
 * Space-level configuration for ad-hoc grant policy.
 * Stored in EntityDirectives or space settings.
 */
export const AdHocGrantPolicySchema = z.object({
  /**
   * Whether ad-hoc capsule delegation is enabled for this space.
   * Default true — spaces can disable if they want skills-only execution.
   */
  enabled: z.boolean().default(true),

  /**
   * Policy-gated operations that are enabled in this space.
   * Only operations from ADHOC_POLICY_GATED are valid here.
   */
  enabledOperations: z.array(z.string().max(128)).max(50).default([]),

  /**
   * Whether bound API endpoints can be granted ad-hoc.
   * Only ratified bindings in the space capability registry are allowed.
   */
  allowBoundApis: z.boolean().default(true),

  /**
   * Whether bound MCP tools can be granted ad-hoc.
   * Only ratified bindings in the space capability registry are allowed.
   */
  allowBoundMcp: z.boolean().default(true),
});

export type AdHocGrantPolicy = z.infer<typeof AdHocGrantPolicySchema>;

// ============================================================================
// Ad-Hoc Capsule Event (for evidence logging)
// ============================================================================

/**
 * Entity event emitted when an ad-hoc capsule pauses or completes.
 * Used for pattern detection (taskSignature clustering) and Coach evidence.
 */
export const AdHocCapsuleEventSchema = z.object({
  type: z.literal('entity.adhoc.capsule_completed'),
  capsuleId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  spaceId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  objective: z.string().max(1000),
  grantedTools: z.array(z.string().max(128)).max(50),
  grantedApis: z.array(z.string().max(128)).max(20),
  taskSignature: z.string().max(256),
  status: z.enum(['succeeded', 'failed', 'blocked', 'timeout']),
  durationMs: z.number().int().nonnegative(),
  userFeedback: z.enum(['positive', 'negative', 'neutral']).optional(),
  errorCategory: z.string().max(128).optional(),
});

export type AdHocCapsuleEvent = z.infer<typeof AdHocCapsuleEventSchema>;

/**
 * Pattern flag event emitted when 3+ similar ad-hoc capsules are detected
 * within a 14-day window. Enters Helmsman attention and Coach evidence.
 */
export const AdHocPatternFlagEventSchema = z.object({
  type: z.literal('entity.adhoc.pattern_flag'),
  spaceId: z.string().min(1).max(128),
  taskSignature: z.string().max(256),
  occurrences: z.number().int().min(3),
  windowDays: z.number().int().positive(),
  sampleObjectives: z.array(z.string().max(1000)).max(5),
  suggestedSkillGoal: z.string().max(500).optional(),
  timestamp: z.string().datetime(),
});

export type AdHocPatternFlagEvent = z.infer<typeof AdHocPatternFlagEventSchema>;

// ============================================================================
// Delegation Context Discriminator
// ============================================================================

/**
 * The `context.kind` value that marks a delegation as an ad-hoc capsule.
 * Used by the delegate handler to scope grant policy enforcement —
 * only capsules are validated, skill-based Runner delegations from the
 * Driver are unaffected.
 */
export const ADHOC_CAPSULE_KIND = 'adhoc_capsule' as const;
