/**
 * Surface Renderer — Streamable realtime UI rendering for Phoenix surfaces.
 *
 * Usage:
 *   import { SurfaceRenderer, StaticSurfaceRenderer } from './index.js';
 *
 * SurfaceRenderer: Accepts mutations[] for streaming or snapshot for hydration.
 * StaticSurfaceRenderer: Snapshot-only, for completed surfaces in run history.
 */
export { SurfaceRenderer, StaticSurfaceRenderer } from './SurfaceRenderer.js';
export type {
  SurfaceRendererProps,
  StaticSurfaceRendererProps,
  SurfaceAction,
} from './SurfaceRenderer.js';
export { useSurfaceStore } from './use-surface-store.js';
export type { UseSurfaceStoreReturn } from './use-surface-store.js';
export { SurfaceComponentRenderer } from './component-registry.js';
export type { RendererContext, ComponentRendererProps } from './component-registry.js';
