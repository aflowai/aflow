'use client';

/**
 * useMapLayout — Shared SVG/Canvas coordinate system for the Entity Map (DL-15).
 *
 * Provides a context that bridges the SVG structural layer with the Canvas
 * motion overlay. Both layers share the same coordinate space, allowing
 * nodes to be positioned in SVG while ripples/flows animate on Canvas.
 *
 * @example
 * ```tsx
 * function MapContainer() {
 *   return (
 *     <MapLayoutProvider width={1200} height={800}>
 *       <svg>...</svg>
 *       <MapCanvasLayer />
 *     </MapLayoutProvider>
 *   );
 * }
 *
 * function SomeNode() {
 *   const { getNodePosition, fireRipple, fireFlow } = useMapLayout();
 *   // ...
 * }
 * ```
 */
import { createContext, useContext, useCallback, useRef, type RefObject } from 'react';
import type { RippleHandle } from '../motion/Ripple.js';
import type { FlowDotHandle } from '../motion/FlowDot.js';
import type { MapNodeKind, MapEdgeKind } from '@aflow/schemas';

// ============================================================================
// Node position registry
// ============================================================================

export interface NodePosition {
  /** Center X in SVG coordinates. */
  cx: number;
  /** Center Y in SVG coordinates. */
  cy: number;
  /** Node width. */
  width: number;
  /** Node height. */
  height: number;
}

// ============================================================================
// Context value
// ============================================================================

export interface MapLayoutContextValue {
  /** Total map width in CSS pixels. */
  width: number;
  /** Total map height in CSS pixels. */
  height: number;

  /** Register a node's position (called by AnatomicalNode on mount/layout). */
  registerNode(kind: MapNodeKind, position: NodePosition): void;

  /** Get a node's current position. */
  getNodePosition(kind: MapNodeKind): NodePosition | undefined;

  /** Fire a ripple at a node. */
  fireRipple(kind: MapNodeKind, color?: string): void;

  /** Fire a flow-dot along an edge. */
  fireFlow(edge: MapEdgeKind, color?: string): void;

  /** Ref to the ripple canvas handle. */
  rippleRef: RefObject<RippleHandle | null>;

  /** Ref to the flow-dot canvas handle. */
  flowRef: RefObject<FlowDotHandle | null>;
}

export const MapLayoutContext = createContext<MapLayoutContextValue | null>(null);

/**
 * Access the shared map layout context. Must be inside a MapLayoutProvider.
 */
export function useMapLayout(): MapLayoutContextValue {
  const ctx = useContext(MapLayoutContext);
  if (!ctx) {
    throw new Error('useMapLayout must be used within a MapLayoutProvider');
  }
  return ctx;
}

// ============================================================================
// Edge → node mapping for flow animations
// ============================================================================

const EDGE_ENDPOINTS: Record<MapEdgeKind, { from: MapNodeKind; to: MapNodeKind }> = {
  trigger_to_helmsman: { from: 'triggers', to: 'helmsman' },
  helmsman_to_memory: { from: 'helmsman', to: 'memory' },
  memory_to_helmsman: { from: 'memory', to: 'helmsman' },
  helmsman_to_runner: { from: 'helmsman', to: 'runner' },
  runner_to_memory: { from: 'runner', to: 'memory' },
  memory_to_runner: { from: 'memory', to: 'runner' },
  runner_to_helmsman: { from: 'runner', to: 'helmsman' },
  runner_to_evals: { from: 'runner', to: 'evals' },
  evals_to_coach: { from: 'evals', to: 'coach' },
  completion_to_coach: { from: 'helmsman', to: 'coach' },
  coach_to_staged: { from: 'coach', to: 'stagedChanges' },
  staged_to_helmsman: { from: 'stagedChanges', to: 'helmsman' },
  staged_to_operator: { from: 'stagedChanges', to: 'helmsman' },
};

export { EDGE_ENDPOINTS };

// ============================================================================
// Provider hook (used by MapLayoutProvider)
// ============================================================================

/**
 * Creates the map layout context value. Used by MapLayoutProvider.
 */
export function useMapLayoutValue(width: number, height: number): MapLayoutContextValue {
  const nodePositions = useRef(new Map<MapNodeKind, NodePosition>());
  const rippleRef = useRef<RippleHandle | null>(null);
  const flowRef = useRef<FlowDotHandle | null>(null);

  const registerNode = useCallback((kind: MapNodeKind, position: NodePosition) => {
    nodePositions.current.set(kind, position);
  }, []);

  const getNodePosition = useCallback((kind: MapNodeKind) => {
    return nodePositions.current.get(kind);
  }, []);

  const fireRipple = useCallback((kind: MapNodeKind, color?: string) => {
    const pos = nodePositions.current.get(kind);
    if (!pos || !rippleRef.current) return;
    // Fire the ripple from the center of the node — color is passed
    // via the Ripple component's own color prop, so we use a default here
    void color; // Color is set at the Ripple component level
    rippleRef.current.fire({ x: pos.cx, y: pos.cy });
  }, []);

  const fireFlow = useCallback((edge: MapEdgeKind, color?: string) => {
    const endpoints = EDGE_ENDPOINTS[edge];
    if (!endpoints) return;
    const fromPos = nodePositions.current.get(endpoints.from);
    const toPos = nodePositions.current.get(endpoints.to);
    if (!fromPos || !toPos || !flowRef.current) return;
    const params: { from: { x: number; y: number }; to: { x: number; y: number }; color?: string } =
      {
        from: { x: fromPos.cx, y: fromPos.cy },
        to: { x: toPos.cx, y: toPos.cy },
      };
    if (color) params.color = color;
    flowRef.current.fire(params);
  }, []);

  return {
    width,
    height,
    registerNode,
    getNodePosition,
    fireRipple,
    fireFlow,
    rippleRef,
    flowRef,
  };
}
