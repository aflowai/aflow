/**
 * MapCanvasLayer — Transparent canvas overlay for ephemeral motion (DL-15).
 *
 * Sits absolutely-positioned on top of the SVG Entity Map, sharing its
 * coordinate space via useMapLayout(). Handles only transient visual effects:
 * ripples, flow-dots, particle bursts. All interactive/readable elements
 * remain in the SVG layer.
 *
 * @example
 * ```tsx
 * <MapLayoutProvider width={1200} height={800}>
 *   <svg>{...structural nodes and edges...}</svg>
 *   <MapCanvasLayer />
 * </MapLayoutProvider>
 * ```
 */
import { useMapLayout } from './hooks/useMapLayout.js';
import { Ripple } from './motion/Ripple.js';
import { FlowDot } from './motion/FlowDot.js';

export interface MapCanvasLayerProps {
  /** Default ripple color. */
  rippleColor?: string;
  /** Default flow-dot color. */
  flowColor?: string;
  /** Disable all canvas animations (for testing). */
  disabled?: boolean;
}

export function MapCanvasLayer({
  rippleColor = 'var(--color-cybernetic-helmsman)',
  flowColor = 'var(--color-cybernetic-runner)',
  disabled,
}: MapCanvasLayerProps) {
  const { width, height, rippleRef, flowRef } = useMapLayout();

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: 'none',
        zIndex: 1,
      }}
      aria-hidden="true"
    >
      <Ripple
        ref={rippleRef}
        width={width}
        height={height}
        color={rippleColor}
        {...(disabled != null ? { disabled } : undefined)}
      />
      <FlowDot
        ref={flowRef}
        width={width}
        height={height}
        color={flowColor}
        {...(disabled != null ? { disabled } : undefined)}
      />
    </div>
  );
}
