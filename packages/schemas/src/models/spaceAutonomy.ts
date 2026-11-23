import { z } from 'zod';
import type { SpaceWriteApprovalPolicy } from './apiDefinition.js';
import { ROOM_MESSAGE_MAX_LENGTH } from '../runtime/roomMessage.js';

/**
 * A space's autonomy posture (Plan 345 D): the one place the rule "nothing
 * waits on the operator" lives, so no prompt has to carry it. The shepherd,
 * the Store and the Helmsman's space context read it, and each surface takes
 * its meaning from {@link SPACE_AUTONOMY_MEANING} rather than from prose of
 * its own.
 */
export const SpaceAutonomySchema = z
  .enum(['full', 'ratify'])
  .describe(
    'Who decides what the space does next. ' +
      '`full`: the Helmsman and the skills decide, and the operator is informed. ' +
      'The only ask that waits on the operator is a credential, entered under Settings → Credentials. ' +
      '`ratify`, the default for a space that never chose: the space asks the operator first. A Store install is a proposal to ratify, ' +
      'a Store update is applied only by the operator, a `comment` review verdict leaves the ' +
      'merge to the operator, and the write approval follows the write policy alone.',
  );
export type SpaceAutonomy = z.infer<typeof SpaceAutonomySchema>;

export const SpaceStoreUpdatesSchema = z
  .enum(['follow-catalog', 'manual'])
  .describe(
    'Whether the platform applies a Store update on its own. ' +
      '`follow-catalog`, the default: under the autonomy `full`, when the catalog moves past an installed version, the ' +
      'platform applies the update, records it as any install, and tells the Helmsman what ' +
      'changed and what to reconcile. An installation with local customizations is not ' +
      'replaced: the Helmsman is told and decides. A failed update is tried again after a wait ' +
      'that doubles with each failure. Under the autonomy `ratify` nothing is applied on its own. ' +
      '`manual`: an update is applied only by `store.listing.update` or from the Store page.',
  );
export type SpaceStoreUpdates = z.infer<typeof SpaceStoreUpdatesSchema>;

/**
 * A space that never chose keeps asking as it did before Plan 345. A space
 * takes `full` only by storing it, so the safety defaults of other spaces
 * do not move.
 */
export const SPACE_AUTONOMY_DEFAULT: SpaceAutonomy = 'ratify';
export const SPACE_STORE_UPDATES_DEFAULT: SpaceStoreUpdates = 'follow-catalog';

/**
 * The conversation records a raise to `full` may cite (Plan 345 D): a message
 * a person sent the Helmsman, with the author the API stamped from the
 * authenticated request. `SessionResumed` carries a message that resumed a
 * conversation (`userMessage` and `actorUserId`). `RoomMessage` carries one
 * posted into a room for the Helmsman (`wakeHelmsman`). No agent session
 * writes either with an author.
 */
export const SpaceAutonomyDirectiveRecordTypeSchema = z.enum(['SessionResumed', 'RoomMessage']);
export type SpaceAutonomyDirectiveRecordType = z.infer<
  typeof SpaceAutonomyDirectiveRecordTypeSchema
>;

/**
 * The operator's directive the last raise to `full` spent: the message of the
 * space's conversation record the raise cited, its author, and when the raise
 * spent it. Only `space.autonomy.update` writes it. A lowering keeps it.
 */
export const SpaceAutonomyDirectiveSchema = z
  .object({
    sessionId: z.string().uuid().describe('The conversation the message was sent in.'),
    eventId: z.string().uuid().describe('The event of the conversation record that holds it.'),
    eventType: SpaceAutonomyDirectiveRecordTypeSchema,
    authorUserId: z
      .string()
      .uuid()
      .describe('The author the API stamped from the authenticated request.'),
    postedAt: z.string().datetime().describe('When the conversation record took the message.'),
    words: z
      .string()
      .min(1)
      .max(ROOM_MESSAGE_MAX_LENGTH)
      .describe('The message as the conversation record holds it.'),
    spentAt: z.string().datetime().describe('When the raise to `full` spent it.'),
  })
  .strict()
  .describe("The operator's directive the last raise to `full` spent.");
export type SpaceAutonomyDirective = z.infer<typeof SpaceAutonomyDirectiveSchema>;

/**
 * The two fields an operator or the Helmsman sets. `PUT
 * /v1/spaces/:spaceId/autonomy` takes this shape and no directive, so no
 * client stores a directive the op did not verify.
 */
export const SpaceAutonomySettingSchema = z
  .object({
    autonomy: SpaceAutonomySchema.optional(),
    storeUpdates: SpaceStoreUpdatesSchema.optional(),
  })
  .strict();
export type SpaceAutonomySetting = z.infer<typeof SpaceAutonomySettingSchema>;

/**
 * The stored setting, one JSONB column on `spaces` (`autonomy_policy`). A
 * field left out takes its default each time it is read; nothing writes the
 * default in. `raisedAt` and `loweredAt` are the autonomy's clock: every
 * write that changes the autonomy records its time, the op's and the route's
 * alike (`nextSpaceAutonomyPolicy`).
 */
export const SpaceAutonomyPolicySchema = SpaceAutonomySettingSchema.extend({
  directive: SpaceAutonomyDirectiveSchema.optional(),
  raisedAt: z
    .string()
    .datetime()
    .optional()
    .describe('When the autonomy last changed from `ratify` to `full`.'),
  loweredAt: z
    .string()
    .datetime()
    .optional()
    .describe(
      'When the autonomy last changed from `full` to `ratify`. A raise needs a message posted after it.',
    ),
}).strict();
export type SpaceAutonomyPolicy = z.infer<typeof SpaceAutonomyPolicySchema>;

/** The two fields an operator or the Helmsman sets, as a stored value holds them. */
export function spaceAutonomySettingOf(policy: SpaceAutonomyPolicy | null): SpaceAutonomySetting {
  const setting: SpaceAutonomySetting = {};
  if (policy?.autonomy !== undefined) setting.autonomy = policy.autonomy;
  if (policy?.storeUpdates !== undefined) setting.storeUpdates = policy.storeUpdates;
  return setting;
}

/**
 * The stored value a write of `setting` leaves (Plan 345 D). The write keeps
 * the stored directive unless the raise spent a new one. It records the time
 * of a change of autonomy: `raisedAt` for a raise, `loweredAt` for a
 * lowering. A write that leaves the autonomy as it was keeps both times.
 * NULL where nothing is left to store.
 */
export function nextSpaceAutonomyPolicy(args: {
  stored: SpaceAutonomyPolicy | null;
  setting: SpaceAutonomySetting | null;
  at: Date;
  directive?: SpaceAutonomyDirective;
}): SpaceAutonomyPolicy | null {
  const before = resolveSpaceAutonomyPolicy(args.stored).autonomy;
  const after = resolveSpaceAutonomyPolicy(args.setting).autonomy;
  const value: SpaceAutonomyPolicy = { ...args.setting };
  const directive = args.directive ?? args.stored?.directive;
  if (directive !== undefined) value.directive = directive;
  const at = args.at.toISOString();
  const raisedAt = before !== 'full' && after === 'full' ? at : args.stored?.raisedAt;
  const loweredAt = before === 'full' && after !== 'full' ? at : args.stored?.loweredAt;
  if (raisedAt !== undefined) value.raisedAt = raisedAt;
  if (loweredAt !== undefined) value.loweredAt = loweredAt;
  return Object.keys(value).length === 0 ? null : value;
}

/** The setting as every reader sees it: each field present, the default where none is stored. */
export const ResolvedSpaceAutonomyPolicySchema = z.object({
  autonomy: SpaceAutonomySchema,
  storeUpdates: SpaceStoreUpdatesSchema,
});
export type ResolvedSpaceAutonomyPolicy = z.infer<typeof ResolvedSpaceAutonomyPolicySchema>;

/**
 * The stored value as read. A value that does not parse takes the defaults, as
 * an absent one does, so one malformed row cannot stop a space's runs.
 */
export function resolveSpaceAutonomyPolicy(stored: unknown): ResolvedSpaceAutonomyPolicy {
  const parsed = stored == null ? undefined : SpaceAutonomyPolicySchema.safeParse(stored);
  const policy = parsed?.success === true ? parsed.data : {};
  return {
    autonomy: policy.autonomy ?? SPACE_AUTONOMY_DEFAULT,
    storeUpdates: policy.storeUpdates ?? SPACE_STORE_UPDATES_DEFAULT,
  };
}

/** What each posture means, as the Helmsman's space context states it. */
export const SPACE_AUTONOMY_MEANING: Record<SpaceAutonomy, string> = {
  full:
    'Autonomy is full. Decide and act, then tell the operator what you did through the ' +
    "space's channel. Ask the operator only for a credential, which they enter under " +
    'Settings → Credentials.',
  ratify:
    'Autonomy is ratify. A Store install is a proposal the operator ratifies. A Store update is ' +
    'theirs to apply from the Store page, so tell them one is available. A merge on a ' +
    '`comment` review verdict is theirs too.',
};

/** What each Store update setting means, as the Helmsman's space context states it. */
export const SPACE_STORE_UPDATES_MEANING: Record<SpaceStoreUpdates, string> = {
  'follow-catalog':
    'Store updates follow the catalog: the platform applies an update when the catalog moves, ' +
    'and lists it under `followed` with what to reconcile. Apply one it could not with ' +
    'store.listing.update.',
  manual: 'Store updates are manual: apply an available update with store.listing.update.',
};

/**
 * The write policy the approval gate reads (Plan 253), with the space's
 * autonomy composed in. Under `full` a medium-tier write — a merge, a comment,
 * a branch — is not gated unless the space's own write policy gates it. A
 * high-tier write keeps its default gate: lowering it stays the write
 * policy's deliberate act.
 */
export function effectiveSpaceWritePolicy(
  policy: SpaceWriteApprovalPolicy | null | undefined,
  autonomy: SpaceAutonomy,
): SpaceWriteApprovalPolicy | null {
  if (autonomy !== 'full') return policy ?? null;
  return {
    ...policy,
    requireApprovalByTier: { medium: false, ...policy?.requireApprovalByTier },
  };
}
