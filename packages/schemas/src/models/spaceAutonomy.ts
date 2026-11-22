import { z } from 'zod';
import type { SpaceWriteApprovalPolicy } from './apiDefinition.js';

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
 * The label a plan document's `document` link carries where the document
 * records the operator's directive to raise the space to `full` (Plan 345 D).
 * The date is the day the operator gave the directive.
 */
export const SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_PREFIX = 'operator directive ';
export const SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_SUFFIX = ': autonomy full';

/** The label for a directive given on `givenOn`, a `YYYY-MM-DD` day. */
export function spaceAutonomyRaiseDirectiveLabel(givenOn: string): string {
  return `${SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_PREFIX}${givenOn}${SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_SUFFIX}`;
}

const RAISE_DIRECTIVE_LABEL =
  /^operator directive (\d{4})-(\d{2})-(\d{2}): autonomy full(?:$|[ .—])/;

/**
 * The day a link label records the operator's directive to raise the space
 * to `full`, or `undefined` where the label records no such directive. The
 * day must be a real calendar day and not after `today`, a `YYYY-MM-DD` day.
 * Text may follow the label after a space, a full stop or a dash, such as the
 * operator's words.
 */
export function parseSpaceAutonomyRaiseDirectiveLabel(
  label: string | null | undefined,
  today: string,
): string | undefined {
  const match = label == null ? null : RAISE_DIRECTIVE_LABEL.exec(label.trim());
  if (match === null) return undefined;
  const [, year, month, day] = match;
  const givenOn = `${year!}-${month!}-${day!}`;
  const parsed = new Date(`${givenOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== givenOn) {
    return undefined;
  }
  return givenOn <= today ? givenOn : undefined;
}

/**
 * The operator's directive a raise to `full` was verified against: the plan
 * node and the `document` link on it that records the directive, and its day.
 * `space.autonomy.update` writes it with the raise and drops it with a
 * lowering.
 */
export const SpaceAutonomyDirectiveSchema = z
  .object({
    nodeId: z
      .string()
      .uuid()
      .describe('The plan node whose `document` link records the directive.'),
    documentRef: z.string().min(1).describe('The plan document, the ref of that link.'),
    label: z.string().min(1).describe('The link label that records the directive and its day.'),
    givenOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('The day the operator gave the directive, `YYYY-MM-DD`.'),
  })
  .strict()
  .describe("The operator's directive the raise to `full` was verified against.");
export type SpaceAutonomyDirective = z.infer<typeof SpaceAutonomyDirectiveSchema>;

/**
 * The stored setting, one JSONB column on `spaces` (`autonomy_policy`). A
 * field left out takes its default each time it is read; nothing writes the
 * default in.
 */
export const SpaceAutonomyPolicySchema = z
  .object({
    autonomy: SpaceAutonomySchema.optional(),
    storeUpdates: SpaceStoreUpdatesSchema.optional(),
    directive: SpaceAutonomyDirectiveSchema.optional(),
  })
  .strict();
export type SpaceAutonomyPolicy = z.infer<typeof SpaceAutonomyPolicySchema>;

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
