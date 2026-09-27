/**
 * Platform caps for stateful applets.
 *
 * The platform performs only structural work on applet writes — these bounds
 * are that work. An applet definition may tighten them via `limits`, never
 * loosen them (encoded as schema maxima on AppletLimitOverridesSchema).
 */
import { z } from 'zod';

// ============================================================================
// State / command caps
// ============================================================================

/** Maximum serialized state snapshot size. Heavy assets are refs, never inline. */
export const APPLET_STATE_MAX_BYTES = 262_144;

/** Maximum RFC 6902 operations in a single patch (command or template). */
export const APPLET_PATCH_MAX_OPS = 128;

/** Maximum JSON nesting depth for state, patches, and action inputs. */
export const APPLET_JSON_MAX_DEPTH = 32;

/** Maximum serialized size of a single action's input. */
export const APPLET_INPUT_MAX_BYTES = 16_384;

/**
 * Maximum length of a view-authored `outcome`. Untrusted, model-visible
 * content — the cap bounds the prompt-injection surface per receipt.
 */
export const APPLET_OUTCOME_MAX_LENGTH = 1_000;

/** Maximum length of a seat's display label pushed into the view. */
export const APPLET_SEAT_LABEL_MAX_LENGTH = 200;

/**
 * Maximum length of a refusal message pushed back into the view. A guard and
 * the gateway write these by hand and they are the only thing the view can
 * show a person about why a change did not land, so the cap is a backstop
 * against an unbounded string on the wire, not a concision rule.
 */
export const APPLET_REFUSAL_MESSAGE_MAX_LENGTH = 2_000;

/** Maximum length of a JSON Pointer (paths, projections, typed refs). */
export const APPLET_JSON_POINTER_MAX_LENGTH = 512;

/** Maximum length of a single pathTemplate segment. */
export const APPLET_PATH_SEGMENT_MAX_LENGTH = 256;

// ============================================================================
// Definition caps
// ============================================================================

/** Maximum declared actions per applet definition. */
export const APPLET_MAX_ACTIONS = 32;

/** Maximum declared roles per applet definition. */
export const APPLET_MAX_ROLES = 16;

/** Maximum pointers in an agentProjection. */
export const APPLET_PROJECTION_MAX_POINTERS = 64;

/** Default receipts projected into a read when the definition declares none. */
export const APPLET_RECENT_ACTIONS_DEFAULT = 20;

/** Hard cap on recentActionsLimit. */
export const APPLET_RECENT_ACTIONS_MAX = 100;

// ============================================================================
// JSON-Schema safety bounds — generated schemas are untrusted runtime input
// ============================================================================

/** The single accepted `$schema` value for generated state/input schemas. */
export const APPLET_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Maximum serialized size of a declared JSON Schema. */
export const APPLET_SCHEMA_MAX_BYTES = 65_536;

/** Maximum nesting depth of a declared JSON Schema. */
export const APPLET_SCHEMA_MAX_DEPTH = 16;

/** Maximum length of a `pattern` regex — an unbounded generated regex is a ReDoS. */
export const APPLET_SCHEMA_MAX_PATTERN_LENGTH = 256;

/** `$ref` targets must be document-local — remote refs are refused outright. */
export const APPLET_SCHEMA_LOCAL_REF_PREFIX = '#';

/**
 * The declared dialect subset: keywords a generated schema may use. Anything
 * outside this set is refused at validation, not silently ignored — a keyword
 * the validator would skip is a rule the author believes exists.
 */
export const APPLET_SCHEMA_ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$ref',
  '$defs',
  // Core
  'type',
  'enum',
  'const',
  // Objects
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  // Arrays
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  // Numbers
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  // Strings
  'minLength',
  'maxLength',
  'pattern',
  'format',
  // Composition
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  // Annotation
  'title',
  'description',
  'default',
  'examples',
]);

// ============================================================================
// Per-definition overrides
// ============================================================================

/**
 * Per-applet tightening of the platform caps. "Never loosen" is carried by
 * the schema itself: every field maxes out at the platform constant.
 */
export const AppletLimitOverridesSchema = z.object({
  maxStateBytes: z.number().int().positive().max(APPLET_STATE_MAX_BYTES).optional(),
  maxPatchOps: z.number().int().positive().max(APPLET_PATCH_MAX_OPS).optional(),
  maxJsonDepth: z.number().int().positive().max(APPLET_JSON_MAX_DEPTH).optional(),
  maxInputBytes: z.number().int().positive().max(APPLET_INPUT_MAX_BYTES).optional(),
  maxOutcomeLength: z.number().int().positive().max(APPLET_OUTCOME_MAX_LENGTH).optional(),
});
export type AppletLimitOverrides = z.infer<typeof AppletLimitOverridesSchema>;

/** Effective caps for one instance's gateway checks. */
export interface AppletLimits {
  maxStateBytes: number;
  maxPatchOps: number;
  maxJsonDepth: number;
  maxInputBytes: number;
  maxOutcomeLength: number;
}

/**
 * Resolve effective limits. Math.min defends against unparsed overrides —
 * a definition read from storage without re-validation still cannot loosen.
 */
export function resolveAppletLimits(overrides?: AppletLimitOverrides): AppletLimits {
  return {
    maxStateBytes: Math.min(APPLET_STATE_MAX_BYTES, overrides?.maxStateBytes ?? Infinity),
    maxPatchOps: Math.min(APPLET_PATCH_MAX_OPS, overrides?.maxPatchOps ?? Infinity),
    maxJsonDepth: Math.min(APPLET_JSON_MAX_DEPTH, overrides?.maxJsonDepth ?? Infinity),
    maxInputBytes: Math.min(APPLET_INPUT_MAX_BYTES, overrides?.maxInputBytes ?? Infinity),
    maxOutcomeLength: Math.min(APPLET_OUTCOME_MAX_LENGTH, overrides?.maxOutcomeLength ?? Infinity),
  };
}
