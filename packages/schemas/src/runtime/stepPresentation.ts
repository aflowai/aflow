import { z } from 'zod';

/**
 * The `rendered_inline` branch carries substrate-specific refs the reducer
 * and the tool-result stub depend on. A nested discriminated union (on
 * `substrate`) keeps each variant's required fields explicit:
 *
 *  - `artifact` ⇒ requires `artifactId` and `versionId`. The view itself is
 *    fetched from the surface that owns it, by version, so no storage
 *    address travels here — one would be a second route to the same bytes
 *    and the only one with no space check behind it.
 *  - `surface`  ⇒ requires `surfaceId` so the reducer can correlate the
 *    inline-surface item with `SurfaceUpdate` / `WorkflowTaskSurfaceUpdate`
 *    mutation streams.
 *  - `applet`   ⇒ requires `instanceId` so the reducer can mount the live,
 *    self-fetching applet card (and dedupe: one card per instance per
 *    session).
 *
 * Zod 3 does not support `discriminatedUnion` whose options are themselves
 * unions, so the nested split is expressed as a top-level
 * `discriminatedUnion('substrate', ...)` for the `rendered_inline` branch.
 * That branch is then placed inside an outer `z.union` keyed by `mode`.
 */
export const RenderedInlineArtifactSchema = z.object({
  mode: z.literal('rendered_inline'),
  substrate: z.literal('artifact'),
  // No storage address: the view is fetched from the surface that owns it,
  // by version. A ref here would be a second way to reach the same bytes,
  // and the one that carries no space check.
  artifactId: z.string().uuid(),
  versionId: z.string().uuid(),
  /**
   * Runtime data that was passed to `ui.artifact.render`. The sandboxed
   * iframe receives it via `postMessage({ type: 'phoenix:data', data })`
   * after mount, so the artifact re-renders with the actual render input
   * instead of falling back to the catalog's sample/default data baked
   * into the compiled HTML.
   *
   * Carried inline. Bundle-shipped artifacts cap `sampleData` at 64 KB
   * (§4.11.1); at-runtime render data is typically the same order of
   * magnitude. Out of band: handlers that need to render very large
   * datasets should ship a PayloadRef-bearing inline item in a future
   * extension — Phase 2.5 keeps this simple.
   */
  data: z.unknown().optional(),
});

export const RenderedInlineSurfaceSchema = z.object({
  mode: z.literal('rendered_inline'),
  substrate: z.literal('surface'),
  surfaceId: z.string().min(1),
});

export const RenderedInlineWorkflowRunSchema = z.object({
  mode: z.literal('rendered_inline'),
  substrate: z.literal('workflow_run'),
  runId: z.string().uuid(),
});

export const RenderedInlineAppletSchema = z.object({
  mode: z.literal('rendered_inline'),
  substrate: z.literal('applet'),
  instanceId: z.string().uuid(),
});

export const RenderedInlinePresentationSchema = z.discriminatedUnion('substrate', [
  RenderedInlineArtifactSchema,
  RenderedInlineSurfaceSchema,
  RenderedInlineWorkflowRunSchema,
  RenderedInlineAppletSchema,
]);

export const SummarizePresentationSchema = z.object({
  mode: z.literal('summarize'),
});

export const StepOutputPresentationSchema = z.union([
  SummarizePresentationSchema,
  RenderedInlinePresentationSchema,
]);

export type StepOutputPresentation = z.infer<typeof StepOutputPresentationSchema>;
export type RenderedInlineArtifact = z.infer<typeof RenderedInlineArtifactSchema>;
export type RenderedInlineSurface = z.infer<typeof RenderedInlineSurfaceSchema>;
export type RenderedInlineWorkflowRun = z.infer<typeof RenderedInlineWorkflowRunSchema>;
export type RenderedInlineApplet = z.infer<typeof RenderedInlineAppletSchema>;
export type RenderedInlinePresentation = z.infer<typeof RenderedInlinePresentationSchema>;
