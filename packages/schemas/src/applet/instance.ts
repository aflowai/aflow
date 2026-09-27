/**
 * Instance identity, lifecycle, membership and journal — first-class rows.
 * The state body is a memory document under the reserved prefix; identity,
 * lifecycle and audit are facts, not payload.
 */
import { z } from 'zod';
import { AppletKeySchema, AppletRoleIdSchema } from './definition.js';
import {
  AppletActionReceiptAgentViewSchema,
  AppletActionReceiptSchema,
  AppletStateVersionSchema,
} from './command.js';
import { AppletStatePatchOpSchema } from './patch.js';

// ============================================================================
// Reserved memory prefix
// ============================================================================

/** Reserved prefix — embedding-suppressed, hidden from knowledge browse, and refused for generic memory writes. */
export const APPLET_MEMORY_PREFIX = '/applets/';

/** Memory doc path of an instance's state snapshot. */
export function appletStatePath(instanceId: string): string {
  return `${APPLET_MEMORY_PREFIX}${instanceId}.json`;
}

// ============================================================================
// Instance
// ============================================================================

export const AppletInstanceIdSchema = z.string().uuid();
export type AppletInstanceId = z.infer<typeof AppletInstanceIdSchema>;

/**
 * 'ended' is flipped structurally by an action's `ends` flag — whether the
 * item is over was the action author's call, never the platform's.
 */
export const AppletInstanceStatusSchema = z.enum(['active', 'ended', 'archived']);
export type AppletInstanceStatus = z.infer<typeof AppletInstanceStatusSchema>;

export const AppletInstanceSchema = z.object({
  instanceId: AppletInstanceIdSchema,
  spaceId: z.string(),
  appletKey: AppletKeySchema,
  /** Platform-computed hash over the canonical validated definition JSON — pinned at instantiation. */
  definitionHash: z.string().min(1).max(128),
  /** The pinned artifact version carrying view + definition as one unit. */
  artifactVersionId: z.string().uuid(),
  /** Memory doc path of the state snapshot (appletStatePath(instanceId)). */
  statePath: z.string(),
  status: AppletInstanceStatusSchema,
  /** The room where this object is being worked — a convenience pointer, re-bindable, never a lifecycle dependency. */
  boundSessionId: z.string().nullable(),
  /** The version the last repin moved off — the rollback target. Absent until the first upgrade. */
  upgradedFromVersionId: z.string().uuid().optional(),
  upgradedAt: z.string().datetime().optional(),
  /** Null after account erasure — provenance columns are SET NULL, never dropped. */
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AppletInstance = z.infer<typeof AppletInstanceSchema>;

/**
 * The instance as agent-facing op outputs carry it. statePath is deliberately
 * absent: exposing the raw state doc's path steers the agent to read it
 * through the memory tools — a side door past the applet read surface
 * (projection, receipts, focus).
 */
export const AppletInstanceAgentViewSchema = AppletInstanceSchema.omit({ statePath: true });
export type AppletInstanceAgentView = z.infer<typeof AppletInstanceAgentViewSchema>;

// ============================================================================
// Membership — typed rows, never JSON inside state
// ============================================================================

export const AppletRoleBindingSchema = z.object({
  instanceId: AppletInstanceIdSchema,
  userId: z.string().uuid(),
  roleId: AppletRoleIdSchema,
  createdAt: z.string().datetime(),
});
export type AppletRoleBinding = z.infer<typeof AppletRoleBindingSchema>;

// ============================================================================
// Journal — append-only receipts + transactional outbox
// ============================================================================

/** Effects relayed after commit. 'ending' is applied inside the write transaction, never relayed. */
export const AppletRelayedEffectKindSchema = z.enum(['notable', 'waking']);
export type AppletRelayedEffectKind = z.infer<typeof AppletRelayedEffectKindSchema>;

/**
 * How a delivered effect landed. 'attention_only' records that the effect had
 * no room to land in (no bound session, or its hot state is gone) — the
 * receipt still surfaces through attention, nothing is dropped silently.
 */
export const AppletEffectDeliveryOutcomeSchema = z.enum([
  'posted',
  'woke',
  'coalesced',
  'attention_only',
  'skipped_agent_actor',
  /** Abandoned after repeated unexpected errors — a poison effect must not starve the queue. */
  'failed',
]);
export type AppletEffectDeliveryOutcome = z.infer<typeof AppletEffectDeliveryOutcomeSchema>;

export const AppletEffectDeliverySchema = z.object({
  effect: AppletRelayedEffectKindSchema,
  status: z.enum(['pending', 'delivered']),
  deliveredAt: z.string().datetime().optional(),
  outcome: AppletEffectDeliveryOutcomeSchema.optional(),
  /** Unexpected-error delivery attempts so far; absent means none. */
  attempts: z.number().int().nonnegative().optional(),
});

/** Attempts after which an effect is abandoned as 'failed' rather than retried. */
export const APPLET_EFFECT_MAX_ATTEMPTS = 5;
export type AppletEffectDelivery = z.infer<typeof AppletEffectDeliverySchema>;

/**
 * One journal row: the receipt plus the outbox state of the effects it owes.
 * Undelivered effects are retried; every destination is idempotent on
 * actionId, and replaying a command re-drives only what is still outstanding.
 */
export const AppletJournalEntrySchema = z.object({
  instanceId: AppletInstanceIdSchema,
  receipt: AppletActionReceiptSchema,
  effectDeliveries: z.array(AppletEffectDeliverySchema),
});
export type AppletJournalEntry = z.infer<typeof AppletJournalEntrySchema>;

// ============================================================================
// Read/list projections
// ============================================================================

/**
 * Values read via the definition's attentionProjection pointers — stringified
 * at read, never interpreted. An applet that declares none gets the generic
 * line (name, lifecycle status, last receipt, version).
 */
export const AppletAttentionSchema = z.object({
  title: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  waitingOn: z.string().max(200).optional(),
});
export type AppletAttention = z.infer<typeof AppletAttentionSchema>;

export const AppletInstanceSummarySchema = AppletInstanceAgentViewSchema.extend({
  stateVersion: AppletStateVersionSchema,
  lastReceipt: AppletActionReceiptAgentViewSchema.optional(),
  attention: AppletAttentionSchema.optional(),
});
export type AppletInstanceSummary = z.infer<typeof AppletInstanceSummarySchema>;

// ============================================================================
// Realtime delivery
// ============================================================================

/**
 * One committed action, published on the `applet.instance` realtime topic
 * after the transaction commits. Subscribers apply the patch when
 * `stateVersion` chains onto what they hold; a gap means refetch — the
 * topic never replays.
 */
export const AppletInstanceDeltaSchema = z.object({
  instanceId: AppletInstanceIdSchema,
  /** Journal seq of the committed action; 0 for a lifecycle repin, which has no journal row. */
  seq: z.number().int().nonnegative(),
  stateVersion: AppletStateVersionSchema,
  patch: z.array(AppletStatePatchOpSchema),
  /**
   * The pinned contract this delta was produced under. A value that differs
   * from the held snapshot's definitionHash means the pin moved — the
   * definition and view are stale, so refetch instead of patching.
   */
  definitionHash: z.string().optional(),
  /** Present when the action changed the instance lifecycle (an ending
   *  action) — state patches alone can never tell a mounted card the
   *  instance ended. */
  status: AppletInstanceStatusSchema.optional(),
});
export type AppletInstanceDelta = z.infer<typeof AppletInstanceDeltaSchema>;
