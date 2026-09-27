/**
 * Runtime state schemas for session variable tracking.
 *
 * These schemas define how session variables are stored and updated during execution.
 * Key principles:
 * - Ref-first: small values may be inlined, large values must use PayloadRef
 * - Schema-true: variable values are validated against their declared schema
 * - Orchestrator is the single writer of runtime state
 */
import { z } from 'zod';

// ============================================================================
// StateValueRef — ref-first value representation
// ============================================================================

/**
 * Inline value — small values stored directly.
 * Must be size-capped; use "ref" kind for anything exceeding ~4KB.
 */
export const InlineStateValueRefSchema = z.object({
  kind: z.literal('inline'),
  /** The actual value (must be JSON-serializable) */
  value: z.unknown(),
  /** MIME content type (e.g. "application/json", "text/markdown") */
  contentType: z.string().optional(),
  /** Semantic type hint for UI rendering (matches StateVariable.semanticType) */
  semanticType: z.string().optional(),
  /** Size in bytes (of the serialized value) */
  sizeBytes: z.number().int().nonnegative().optional(),
});

/**
 * Referenced value — large values stored in the payload store.
 * The hot path never dereferences these; UI fetches on demand.
 */
export const RefStateValueRefSchema = z.object({
  kind: z.literal('ref'),
  /** Payload reference (gs:// or inline: URI) */
  payloadRef: z.string(),
  /** MIME content type */
  contentType: z.string().optional(),
  /** Semantic type hint for UI rendering */
  semanticType: z.string().optional(),
  /** Size in bytes */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Optional preview for UI (strictly size-limited, ~1-4KB) */
  preview: z
    .object({
      text: z.string().optional(),
      json: z.unknown().optional(),
    })
    .optional(),
});

/**
 * A runtime value: either inlined or referenced.
 */
export const StateValueRefSchema = z.discriminatedUnion('kind', [
  InlineStateValueRefSchema,
  RefStateValueRefSchema,
]);

export type StateValueRef = z.infer<typeof StateValueRefSchema>;

// ============================================================================
// RuntimeStateValue — wraps ref with update metadata
// ============================================================================

export const RuntimeStateValueSchema = z.object({
  /** The value (inline or ref) */
  ref: StateValueRefSchema,
  /** When this value was last updated (epoch ms) */
  updatedAtMs: z.number(),
  /** Who/what updated this value */
  updatedBy: z
    .object({
      stepExecutionId: z.string().uuid().optional(),
      stepId: z.string().optional(),
      actor: z.enum(['orchestrator', 'executor', 'api']).optional(),
    })
    .default({}),
  /** Monotonic version counter for this variable */
  version: z.number().int().nonnegative().default(0),
});

export type RuntimeStateValue = z.infer<typeof RuntimeStateValueSchema>;

// ============================================================================
// RuntimeState — the session's live variable map
// ============================================================================

export const SessionRuntimeStateSchema = z.object({
  /** Schema version for future migrations */
  schemaVersion: z.literal(1).default(1),
  /** Variable map: variableId → RuntimeStateValue */
  variables: z.record(z.string(), RuntimeStateValueSchema).default({}),
  /** Monotonic version counter for the whole runtime state (increments on any write) */
  version: z.number().int().nonnegative().default(0),
  /** Last update timestamp (epoch ms) */
  updatedAtMs: z.number(),
});

export type SessionRuntimeState = z.infer<typeof SessionRuntimeStateSchema>;

// ============================================================================
// RuntimeStatePatch — delta updates for events
// ============================================================================

/**
 * A patch describing changes to the runtime state.
 * Used in events to communicate variable updates without dumping full state.
 */
export const RuntimeStatePatchSchema = z.object({
  /** New runtime state version after applying this patch */
  version: z.number().int().nonnegative(),
  /** Variables that changed */
  changed: z.array(
    z.object({
      /** Variable key */
      key: z.string(),
      /** New value */
      value: RuntimeStateValueSchema,
    }),
  ),
  /** Variables that were removed (v1: not used, reserved for future) */
  removed: z.array(z.string()).default([]),
});

export type RuntimeStatePatch = z.infer<typeof RuntimeStatePatchSchema>;

// ============================================================================
// Helpers
// ============================================================================

/** Maximum inline value size in bytes before requiring a ref */
export const MAX_INLINE_STATE_VALUE_BYTES = 4096; // 4KB

/**
 * Create an inline StateValueRef from a value.
 */
export function inlineValue(
  value: unknown,
  opts?: { semanticType?: string; contentType?: string },
): StateValueRef {
  return {
    kind: 'inline',
    value,
    semanticType: opts?.semanticType,
    contentType: opts?.contentType ?? 'application/json',
  };
}

/**
 * Create a ref StateValueRef from a payload reference.
 */
export function refValue(
  payloadRef: string,
  opts?: {
    semanticType?: string;
    contentType?: string;
    sizeBytes?: number;
    preview?: { text?: string; json?: unknown };
  },
): StateValueRef {
  return {
    kind: 'ref',
    payloadRef,
    semanticType: opts?.semanticType,
    contentType: opts?.contentType,
    sizeBytes: opts?.sizeBytes,
    preview: opts?.preview,
  };
}

/**
 * Create a RuntimeStateValue wrapping a StateValueRef.
 */
export function createRuntimeStateValue(
  ref: StateValueRef,
  updatedBy: RuntimeStateValue['updatedBy'],
  version = 0,
): RuntimeStateValue {
  return {
    ref,
    updatedAtMs: Date.now(),
    updatedBy,
    version,
  };
}

/**
 * Create an empty SessionRuntimeState.
 */
export function createEmptyRuntimeState(): SessionRuntimeState {
  return {
    schemaVersion: 1,
    variables: {},
    version: 0,
    updatedAtMs: Date.now(),
  };
}

/**
 * Apply a patch to a SessionRuntimeState, returning a new SessionRuntimeState.
 */
export function applyRuntimeStatePatch(
  state: SessionRuntimeState,
  patch: RuntimeStatePatch,
): SessionRuntimeState {
  let newVariables = { ...state.variables };

  for (const change of patch.changed) {
    newVariables[change.key] = change.value;
  }

  for (const key of patch.removed) {
    const { [key]: _omit, ...rest } = newVariables;
    newVariables = rest;
  }

  return {
    ...state,
    variables: newVariables,
    version: patch.version,
    updatedAtMs: Date.now(),
  };
}
