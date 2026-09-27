/**
 * The command envelope and action receipt — one envelope identical for both
 * actors (a human click through the view, the agent through ui.applet.act),
 * one canonical receipt consumed by the iframe, the agent, the room, the
 * audit view and the tests.
 */
import { z } from 'zod';
import { AppletActionNameSchema } from './definition.js';
import { AppletStatePatchOpSchema, AppletStatePatchSchema } from './patch.js';
import { APPLET_OUTCOME_MAX_LENGTH } from './limits.js';

// ============================================================================
// Primitives
// ============================================================================

/** Client-generated idempotency key — replaying it returns the original receipt. */
export const AppletActionIdSchema = z.string().uuid();
export type AppletActionId = z.infer<typeof AppletActionIdSchema>;

export const AppletStateVersionSchema = z.number().int().nonnegative();
export type AppletStateVersion = z.infer<typeof AppletStateVersionSchema>;

/**
 * Who performed an action. Server-stamped at the authenticated boundary, never
 * client-supplied. Exactly what the journal persists (`actor_user_id` /
 * `actor_agent_role`) — richer provenance for agent actions (session, run,
 * step) lives in the step trace the action was lowered from, not here.
 */
export const AppletActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    /** Null after account erasure — provenance columns are SET NULL, never dropped. */
    userId: z.string().uuid().nullable(),
    /** Display only. Authorization reads the id. */
    displayName: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    /** Coarse platform role label, e.g. 'helmsman' — the persisted identity. */
    agentRole: z.string().min(1).max(64),
    displayName: z.string().max(200).optional(),
  }),
]);
export type AppletActor = z.infer<typeof AppletActorSchema>;

/**
 * View-authored, human-readable result of an action. Untrusted, model-visible
 * content — length-capped, markup-stripped at ingestion, and rendered to the
 * agent with explicit `applet-reported` provenance.
 */
export const AppletOutcomeSchema = z.string().max(APPLET_OUTCOME_MAX_LENGTH);

// ============================================================================
// Command
// ============================================================================

export const AppletCommandSchema = z.object({
  actionId: AppletActionIdSchema,
  /** The state version this command was computed against. */
  baseVersion: AppletStateVersionSchema,
  name: AppletActionNameSchema,
  /** The declared action's typed input, validated against its inputSchema. */
  input: z.record(z.unknown()),
  /**
   * RFC 6902, confined to /state. Forbidden for template actions, required
   * for actor_supplied actions — whoever acts computes the change.
   */
  proposedPatch: AppletStatePatchSchema.optional(),
  outcome: AppletOutcomeSchema.optional(),
});
export type AppletCommand = z.infer<typeof AppletCommandSchema>;

// ============================================================================
// Receipt
// ============================================================================

/** Derived from the action's declared flags — never client-supplied. */
export const AppletActionEffectsSchema = z.object({
  notable: z.boolean(),
  waking: z.boolean(),
  ending: z.boolean(),
});
export type AppletActionEffects = z.infer<typeof AppletActionEffectsSchema>;

export const AppletActionReceiptSchema = z.object({
  actionId: AppletActionIdSchema,
  /** Instance-scoped journal sequence — numbers every action, gap-free. */
  seq: z.number().int().positive(),
  actor: AppletActorSchema,
  name: AppletActionNameSchema,
  /** What was intended. For actor_supplied actions the patch is authoritative and this is descriptive. */
  input: z.record(z.unknown()),
  beforeVersion: AppletStateVersionSchema,
  afterVersion: AppletStateVersionSchema,
  /** The applied patch — what actually happened. */
  patch: z.array(AppletStatePatchOpSchema),
  outcome: AppletOutcomeSchema.optional(),
  effects: AppletActionEffectsSchema,
  at: z.string().datetime(),
});
export type AppletActionReceipt = z.infer<typeof AppletActionReceiptSchema>;

/**
 * The receipt as agent-facing op outputs carry it: the applied patch is
 * dropped — it is derivable, it is the heaviest field (a template move is
 * seven ops; an analysis refresh embeds a whole computed object), and twenty
 * of them once blew the turn's summary budget and failed the session. The
 * HTTP plane keeps full receipts (the view folds receipt patches into its
 * held state).
 */
export const AppletActionReceiptAgentViewSchema = AppletActionReceiptSchema.omit({ patch: true });
export type AppletActionReceiptAgentView = z.infer<typeof AppletActionReceiptAgentViewSchema>;
