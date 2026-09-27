/**
 * Applet patch contracts — RFC 6902 confined to /state, and typed patch
 * templates with typed value/path references. There is NO string
 * interpolation anywhere in this surface: values ride `valueFrom` pointers
 * unchanged, and dynamic path segments are typed `{ from }` refs that are
 * RFC 6901-escaped at materialization.
 */
import { z } from 'zod';
import {
  APPLET_JSON_POINTER_MAX_LENGTH,
  APPLET_PATCH_MAX_OPS,
  APPLET_PATH_SEGMENT_MAX_LENGTH,
} from './limits.js';

// ============================================================================
// JSON Pointers
// ============================================================================

const JSON_POINTER_BODY = '(/([^/~]|~0|~1)*)*';

/** RFC 6901 JSON Pointer ('' is the whole document). */
export const JSON_POINTER_RE = new RegExp(`^${JSON_POINTER_BODY}$`);

/** The state subtree of the instance document — the only writable region. */
export const APPLET_STATE_POINTER_PREFIX = '/state';

/** The substitution scope for template refs — the action's validated input. */
export const APPLET_INPUT_POINTER_PREFIX = '/input';

export const APPLET_STATE_POINTER_RE = new RegExp(
  `^${APPLET_STATE_POINTER_PREFIX}${JSON_POINTER_BODY}$`,
);
export const APPLET_INPUT_POINTER_RE = new RegExp(
  `^${APPLET_INPUT_POINTER_PREFIX}${JSON_POINTER_BODY}$`,
);

export const AppletJsonPointerSchema = z
  .string()
  .max(APPLET_JSON_POINTER_MAX_LENGTH)
  .regex(JSON_POINTER_RE)
  .describe('RFC 6901 JSON Pointer');

export const AppletStatePointerSchema = z
  .string()
  .max(APPLET_JSON_POINTER_MAX_LENGTH)
  .regex(APPLET_STATE_POINTER_RE)
  .describe("JSON Pointer confined to the '/state' subtree — '/meta' is server-owned");

export const AppletInputPointerSchema = z
  .string()
  .max(APPLET_JSON_POINTER_MAX_LENGTH)
  .regex(APPLET_INPUT_POINTER_RE)
  .describe("Typed reference into the action's input, e.g. '/input/amount'");

// ============================================================================
// Actor-supplied patches — RFC 6902, /state-confined
// ============================================================================

export const AppletStatePatchOpSchema = z
  .object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: AppletStatePointerSchema,
    from: AppletStatePointerSchema.optional(),
    value: z.unknown().optional(),
  })
  .superRefine((patchOp, ctx) => {
    const needsValue = patchOp.op === 'add' || patchOp.op === 'replace' || patchOp.op === 'test';
    if (needsValue && patchOp.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `'${patchOp.op}' requires a value`,
      });
    }
    const needsFrom = patchOp.op === 'move' || patchOp.op === 'copy';
    if (needsFrom && patchOp.from === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: `'${patchOp.op}' requires a from pointer`,
      });
    }
  });
export type AppletStatePatchOp = z.infer<typeof AppletStatePatchOpSchema>;

export const AppletStatePatchSchema = z
  .array(AppletStatePatchOpSchema)
  .min(1)
  .max(APPLET_PATCH_MAX_OPS)
  .describe('RFC 6902 patch confined to /state');
export type AppletStatePatch = z.infer<typeof AppletStatePatchSchema>;

// ============================================================================
// Template patches — pure functions of input, materialized by the platform
// ============================================================================

/**
 * One pathTemplate segment: a literal, or the value read at an input pointer.
 * Both are RFC 6901-escaped when the path is materialized, so input can never
 * forge pointer structure.
 */
export const AppletPatchTemplateSegmentSchema = z.union([
  z.string().min(1).max(APPLET_PATH_SEGMENT_MAX_LENGTH),
  z.object({ from: AppletInputPointerSchema }),
]);
export type AppletPatchTemplateSegment = z.infer<typeof AppletPatchTemplateSegmentSchema>;

/** A /state-rooted pointer head followed by literal or input-derived segments. */
export const AppletPatchPathTemplateSchema = z
  .tuple([AppletStatePointerSchema])
  .rest(AppletPatchTemplateSegmentSchema);
export type AppletPatchPathTemplate = z.infer<typeof AppletPatchPathTemplateSchema>;

export const AppletTemplatePatchOpSchema = z
  .object({
    op: z.enum(['add', 'replace', 'remove', 'test']),
    path: AppletStatePointerSchema.optional(),
    pathTemplate: AppletPatchPathTemplateSchema.optional(),
    /** Typed reference — the value at this input pointer, carried unchanged. */
    valueFrom: AppletInputPointerSchema.optional(),
    /** Literal value baked into the template. */
    value: z.unknown().optional(),
  })
  .superRefine((patchOp, ctx) => {
    if ((patchOp.path !== undefined) === (patchOp.pathTemplate !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'Exactly one of path or pathTemplate is required',
      });
    }
    const hasValue = patchOp.value !== undefined;
    const hasValueFrom = patchOp.valueFrom !== undefined;
    if (patchOp.op === 'remove') {
      if (hasValue || hasValueFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: "'remove' carries no value or valueFrom",
        });
      }
    } else if (hasValue === hasValueFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `'${patchOp.op}' requires exactly one of value or valueFrom`,
      });
    }
  });
export type AppletTemplatePatchOp = z.infer<typeof AppletTemplatePatchOpSchema>;

export const AppletTemplatePatchSchema = z.object({
  template: z.array(AppletTemplatePatchOpSchema).min(1).max(APPLET_PATCH_MAX_OPS),
});
export type AppletTemplatePatch = z.infer<typeof AppletTemplatePatchSchema>;

/** Marker for actions whose patch is computed by whoever acts (view or agent). */
export const ACTOR_SUPPLIED_PATCH = 'actor_supplied' as const;

/**
 * An action's declared patch mode: a template materialized by the platform
 * from input alone, or actor-supplied (state-dependent — the view computes it
 * for a human, the agent computes its own).
 */
export const AppletActionPatchSchema = z.union([
  AppletTemplatePatchSchema,
  z.literal(ACTOR_SUPPLIED_PATCH),
]);
export type AppletActionPatch = z.infer<typeof AppletActionPatchSchema>;

/**
 * A declarative pre-apply assertion the gateway evaluates against current
 * state: the value at `assert` (segments may derive from input) must equal
 * `equals`. Built for applets whose view projects derived validity data into
 * state (a legal-move map, an allowed-transition set): the applet declares
 * the rule, the platform only dereferences pointers — no domain code runs.
 *
 * `freshness` scopes the assertion to derived data that is current: the
 * integer at `stamp` must equal the length of the array at `matchesLengthOf`,
 * else `onUnverifiable` decides (an 'allow' guard enforces only what it can
 * prove — it never blocks play the view has not analyzed).
 *
 * `bypass` names a boolean input that skips the guard entirely — the escape
 * hatch is part of the action's own contract and rides the receipt, so every
 * agreed exception is journaled.
 */
export const AppletActionGuardSchema = z.object({
  assert: AppletPatchPathTemplateSchema,
  equals: z.unknown(),
  freshness: z
    .object({
      stamp: AppletStatePointerSchema,
      matchesLengthOf: AppletStatePointerSchema,
    })
    .optional(),
  onUnverifiable: z.enum(['allow', 'reject']),
  bypass: AppletInputPointerSchema.optional(),
  /** The rejection the actor sees — teach the fix, not just the refusal. */
  message: z.string().min(1).max(300),
});
export type AppletActionGuard = z.infer<typeof AppletActionGuardSchema>;
