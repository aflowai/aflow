/**
 * The view contract — the postMessage protocol between the host and the applet
 * iframe. Host pushes state, the view sends the same command envelope the
 * agent uses, and every command gets an explicit result so optimistic
 * reconciliation and retry behaviour are defined.
 *
 * `spaceRole` (a real permission the platform enforces) and `appletRoles`
 * (domain labels the platform never interprets) are separate axes.
 */
import { z } from 'zod';
import { SpaceRoleSchema } from '../identity/user.js';
import { AppletActionNameSchema, AppletRoleIdSchema } from './definition.js';
import {
  AppletActionIdSchema,
  AppletActionReceiptSchema,
  AppletCommandSchema,
  AppletStateVersionSchema,
} from './command.js';
import {
  APPLET_MAX_ACTIONS,
  APPLET_MAX_ROLES,
  APPLET_REFUSAL_MESSAGE_MAX_LENGTH,
  APPLET_SEAT_LABEL_MAX_LENGTH,
} from './limits.js';

export const PHOENIX_APPLET_STATE_MESSAGE_TYPE = 'phoenix:state';
export const PHOENIX_APPLET_ACTION_MESSAGE_TYPE = 'phoenix:action';
export const PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE = 'phoenix:action-result';

export const PhoenixAppletViewerSchema = z.object({
  userId: z.string().uuid(),
  /** Real permission axis — the platform refuses a viewer's write. */
  spaceRole: SpaceRoleSchema,
  /** Domain labels ('white', 'reviewer') — courtesy rendering only. */
  appletRoles: z.array(AppletRoleIdSchema).max(APPLET_MAX_ROLES),
});
export type PhoenixAppletViewer = z.infer<typeof PhoenixAppletViewerSchema>;

/** Who holds a declared seat — display labels resolved by the host, never emails. */
export const PhoenixAppletSeatSchema = z.object({
  roleId: AppletRoleIdSchema,
  displayName: z.string().max(APPLET_SEAT_LABEL_MAX_LENGTH),
});
export type PhoenixAppletSeat = z.infer<typeof PhoenixAppletSeatSchema>;

/** Host → iframe: current state push (mount, and every applied version). */
export const PhoenixAppletStateMessageSchema = z.object({
  type: z.literal(PHOENIX_APPLET_STATE_MESSAGE_TYPE),
  state: z.record(z.unknown()),
  version: AppletStateVersionSchema,
  viewer: PhoenixAppletViewerSchema,
  /** Courtesy rendering only — same axis as appletRoles, for naming the other seats. */
  seats: z.array(PhoenixAppletSeatSchema).max(APPLET_MAX_ROLES).optional(),
});
export type PhoenixAppletStateMessage = z.infer<typeof PhoenixAppletStateMessageSchema>;

/** Iframe → host: the command envelope, identical to what the agent sends. */
export const PhoenixAppletActionMessageSchema = AppletCommandSchema.extend({
  type: z.literal(PHOENIX_APPLET_ACTION_MESSAGE_TYPE),
  /** Bookkeeping the view fires on its own (no human gesture) — the host
   *  surfaces no conflict banner for it; losing a CAS race is its normal. */
  silent: z.boolean().optional(),
});
export type PhoenixAppletActionMessage = z.infer<typeof PhoenixAppletActionMessageSchema>;

export const PhoenixAppletActionResultStatusSchema = z.enum(['applied', 'conflict', 'rejected']);
export type PhoenixAppletActionResultStatus = z.infer<typeof PhoenixAppletActionResultStatusSchema>;

/** Which refusal it was — the gateway's own slug, for a view that branches on it. */
export const PhoenixAppletRefusalReasonSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

/** Host → iframe: the outcome of one command — applied, conflicted, or refused. */
export const PhoenixAppletActionResultMessageSchema = z.object({
  type: z.literal(PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE),
  actionId: AppletActionIdSchema,
  status: PhoenixAppletActionResultStatusSchema,
  /** Present when applied — the canonical record of what happened. */
  receipt: AppletActionReceiptSchema.optional(),
  /** Present on conflict — the version to reread and recompute against. */
  currentVersion: AppletStateVersionSchema.optional(),
  /**
   * Present on rejection — why the refusal happened, in the words the guard or
   * the gateway wrote. This is the whole teaching surface for a refusal: the
   * view has nothing else to tell the person what to do differently.
   */
  message: z.string().max(APPLET_REFUSAL_MESSAGE_MAX_LENGTH).optional(),
  /** Present on rejection — which refusal it was, for a view that branches. */
  reason: PhoenixAppletRefusalReasonSchema.optional(),
  /** Present on rejection — structural validation failures, human-readable. */
  validation: z.array(z.string().max(1_000)).max(50).optional(),
  /** Present on rejection — the declared surface, for a refused action name. */
  availableActions: z.array(AppletActionNameSchema).max(APPLET_MAX_ACTIONS).optional(),
});
export type PhoenixAppletActionResultMessage = z.infer<
  typeof PhoenixAppletActionResultMessageSchema
>;
