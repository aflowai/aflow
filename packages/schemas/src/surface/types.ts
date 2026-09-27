/**
 * Surface foundational types — shared by both operations/ui.ts and surface/messages.ts.
 *
 * This file exists to break the circular dependency between those two modules.
 * Both import these base schemas from here instead of from each other.
 */
import { z } from 'zod';

// =============================================================================
// Component types
// =============================================================================

/**
 * Semantic surface component types — the generation-facing surface language.
 * These map deterministically to DS components via a client-owned renderer.
 */
export const SurfaceComponentTypeSchema = z.enum([
  'Page',
  'Section',
  'Panel',
  'Heading',
  'Text',
  'MetricGrid',
  'DataTable',
  'List',
  'Form',
  'Field',
  'Button',
  'Chart',
  'ChatComposer',
  'Image',
  'CodeBlock',
  'Divider',
  'Badge',
  'Icon',
]);
export type SurfaceComponentType = z.infer<typeof SurfaceComponentTypeSchema>;

// =============================================================================
// Action types
// =============================================================================

/** Surface action event types for client-to-server bubbling. */
export const SurfaceEventTypeSchema = z.enum([
  'click',
  'message',
  'submit',
  'navigate',
  'invoke',
  'select',
  'change',
  'custom',
]);
export type SurfaceEventType = z.infer<typeof SurfaceEventTypeSchema>;

/** Surface action target — where the event should be routed. */
export const SurfaceActionTargetSchema = z.enum(['agent', 'flow', 'step', 'client']);
export type SurfaceActionTarget = z.infer<typeof SurfaceActionTargetSchema>;

/** Declarative action definition on a surface component. */
export const SurfaceActionDefinitionSchema = z.object({
  eventName: z.string().max(128),
  eventType: SurfaceEventTypeSchema,
  target: SurfaceActionTargetSchema.optional(),
  payloadTemplate: z.record(z.unknown()).optional(),
  includeDataModel: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type SurfaceActionDefinition = z.infer<typeof SurfaceActionDefinitionSchema>;

// =============================================================================
// Message types
// =============================================================================

/** Surface mutation message types. */
export const SurfaceMessageTypeSchema = z.enum([
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'completeSurface',
  'surfaceError',
]);
export type SurfaceMessageType = z.infer<typeof SurfaceMessageTypeSchema>;
