/**
 * Surface Protocol Messages — Enhanced mutation message types for streamable surfaces.
 *
 * Builds on the existing UiSurfaceMessage shape defined in operations/ui.ts
 * but adds typed component validation and data model operations.
 *
 * Protocol:
 * 1. createSurface — establish surface identity and catalog version
 * 2. updateComponents — upsert components by ID (new ID = create, existing = update)
 * 3. updateDataModel — patch data model at JSON Pointer paths
 * 4. deleteSurface — remove surface entirely
 * 5. completeSurface — signal generation is done (surface stays rendered)
 * 6. surfaceError — report an error
 *
 * Messages are streamed as JSONL. Each line is one complete JSON message.
 */
import { z } from 'zod';

import { SurfaceActionDefinitionSchema, SurfaceComponentTypeSchema } from './types.js';

// =============================================================================
// Typed surface component — enhanced version with per-type prop validation
// =============================================================================

/**
 * A single component in the flat surface graph.
 * This is the wire format — props are validated against the component's
 * schema by the surface engine before reaching the renderer.
 */
export const TypedSurfaceComponentSchema = z.object({
  /** Stable unique ID within the surface. New ID = create, existing = update. */
  id: z.string().min(1).max(128),
  /** Semantic component type from the surface catalog. */
  component: SurfaceComponentTypeSchema,
  /** Component-specific props. Validated against the component's prop schema. */
  props: z.record(z.unknown()).optional(),
  /** Ordered child component IDs for layout composition. */
  children: z.array(z.string().max(128)).optional(),
  /**
   * Data model bindings: prop-name → JSON Pointer path.
   * Example: { "text": "/title", "items": "/metrics" }
   * The renderer resolves these against the surface data model.
   */
  bindings: z.record(z.string()).optional(),
  /** Declarative actions attached to this component. */
  actions: z.array(SurfaceActionDefinitionSchema).optional(),
});
export type TypedSurfaceComponent = z.infer<typeof TypedSurfaceComponentSchema>;

// =============================================================================
// Individual mutation message schemas
// =============================================================================

/** createSurface — first message, establishes the surface. */
export const CreateSurfacePayloadSchema = z.object({
  type: z.literal('createSurface'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  /** Initial components (optional — can also be sent via updateComponents). */
  components: z.array(TypedSurfaceComponentSchema).optional(),
  /** Root component IDs defining render order. */
  rootIds: z.array(z.string()).optional(),
  /** Initial data model (optional — can also be sent via updateDataModel). */
  dataModel: z.record(z.unknown()).optional(),
  /** Surface title for UI chrome. */
  title: z.string().max(200).optional(),
});
export type CreateSurfacePayload = z.infer<typeof CreateSurfacePayloadSchema>;

/** updateComponents — upsert components by ID. */
export const UpdateComponentsPayloadSchema = z.object({
  type: z.literal('updateComponents'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  /** Components to create or update. */
  components: z.array(TypedSurfaceComponentSchema),
  /** Update root IDs if layout order changed. */
  rootIds: z.array(z.string()).optional(),
});
export type UpdateComponentsPayload = z.infer<typeof UpdateComponentsPayloadSchema>;

/** updateDataModel — patch data model at JSON Pointer paths. */
export const UpdateDataModelPayloadSchema = z.object({
  type: z.literal('updateDataModel'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  /**
   * Data model patch. Keys are JSON Pointer paths, values are the data.
   * Example: { "/metrics": [...], "/title": "Dashboard" }
   * Use "/" for the root data model replacement.
   */
  dataModel: z.record(z.unknown()),
});
export type UpdateDataModelPayload = z.infer<typeof UpdateDataModelPayloadSchema>;

/** deleteSurface — remove the surface. */
export const DeleteSurfacePayloadSchema = z.object({
  type: z.literal('deleteSurface'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
});
export type DeleteSurfacePayload = z.infer<typeof DeleteSurfacePayloadSchema>;

/** completeSurface — generation finished, surface stays rendered. */
export const CompleteSurfacePayloadSchema = z.object({
  type: z.literal('completeSurface'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  /** Optional snapshot of final surface state for persistence. */
  snapshotRef: z.string().optional(),
});
export type CompleteSurfacePayload = z.infer<typeof CompleteSurfacePayloadSchema>;

/** surfaceError — report a generation or rendering error. */
export const SurfaceErrorPayloadSchema = z.object({
  type: z.literal('surfaceError'),
  surfaceId: z.string().min(1).max(256),
  messageId: z.string().min(1),
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  error: z.object({
    code: z.string().max(128),
    message: z.string().max(4000),
    recoverable: z.boolean().optional(),
  }),
});
export type SurfaceErrorPayload = z.infer<typeof SurfaceErrorPayloadSchema>;

// =============================================================================
// Discriminated union of all surface messages
// =============================================================================

/**
 * A single surface mutation message — the fundamental unit of the
 * streamable surface protocol. Each JSONL line is one of these.
 */
export const SurfaceMutationSchema = z.discriminatedUnion('type', [
  CreateSurfacePayloadSchema,
  UpdateComponentsPayloadSchema,
  UpdateDataModelPayloadSchema,
  DeleteSurfacePayloadSchema,
  CompleteSurfacePayloadSchema,
  SurfaceErrorPayloadSchema,
]);
export type SurfaceMutation = z.infer<typeof SurfaceMutationSchema>;

/**
 * Convenience type guard for checking message types.
 */
export function isSurfaceMutation(value: unknown): value is SurfaceMutation {
  return SurfaceMutationSchema.safeParse(value).success;
}

/**
 * Parse a JSONL line into a validated SurfaceMutation.
 * Returns { success: true, data } or { success: false, error }.
 */
export function parseSurfaceMutation(
  line: string,
): z.SafeParseReturnType<unknown, SurfaceMutation> {
  try {
    const parsed: unknown = JSON.parse(line);
    return SurfaceMutationSchema.safeParse(parsed);
  } catch {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message: `Invalid JSON: ${line.slice(0, 500)}`,
          path: [],
        },
      ]),
    };
  }
}

// =============================================================================
// Surface state snapshot — for persistence and hydration
// =============================================================================

/**
 * Complete snapshot of a surface's state at a point in time.
 * Used for persistence, hydration, and debugging.
 */
export const SurfaceSnapshotSchema = z.object({
  surfaceId: z.string(),
  catalogVersion: z.string(),
  /** All components keyed by ID. */
  components: z.record(TypedSurfaceComponentSchema),
  /** Root component IDs in render order. */
  rootIds: z.array(z.string()),
  /** Current data model. */
  dataModel: z.record(z.unknown()),
  /** Whether the surface generation is complete. */
  completed: z.boolean(),
  /** Total messages applied. */
  messageCount: z.number().int().nonnegative(),
  /** Timestamp of last mutation. */
  lastUpdated: z.string().datetime(),
});
export type SurfaceSnapshot = z.infer<typeof SurfaceSnapshotSchema>;
