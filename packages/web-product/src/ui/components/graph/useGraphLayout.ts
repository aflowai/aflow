'use client';

/**
 * Generic ELK-based auto-layout hook for React Flow graphs.
 *
 * Owns the React Flow node/edge state for its consumer (so layout updates
 * propagate cleanly into the canvas without remounting). Re-runs layout
 * whenever the structural identity of the inputs changes (id-set delta);
 * otherwise preserves operator-pinned positions and only refreshes node
 * `data`. Mirrors the original FlowCanvas inline implementation that ships
 * the agent editor today.
 *
 * Used by every graph surface in the console — agent editor, workflow
 * inspector, and (Phase 3) the process map.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react';

import { computeLayout, type LayoutOptions } from '../../lib/flow-layout.js';

export interface UseGraphLayoutResult<NData extends Record<string, unknown>> {
  nodes: Array<Node<NData>>;
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<NData>>;
  onEdgesChange: OnEdgesChange;
  isLayouting: boolean;
  /** Manually trigger a re-layout. Useful for "reset positions" buttons. */
  relayout: () => Promise<void>;
}

export interface UseGraphLayoutOptions extends LayoutOptions {
  /** Padding passed to fitView after a layout pass. Default 0.15. */
  fitViewPadding?: number | undefined;
  /** Animation duration for fitView in ms. Default 300. */
  fitViewDuration?: number | undefined;
}

export function useGraphLayout<NData extends Record<string, unknown>>(
  rawNodes: Array<Node<NData>>,
  rawEdges: Edge[],
  options: UseGraphLayoutOptions = {},
): UseGraphLayoutResult<NData> {
  const { fitViewPadding = 0.15, fitViewDuration = 300, ...layoutOpts } = options;
  const { fitView } = useReactFlow();
  const layoutDone = useRef(false);

  const [nodes, setNodes] = useState<Array<Node<NData>>>(rawNodes);
  const [edges, setEdges] = useState<Edge[]>(rawEdges);
  const [isLayouting, setIsLayouting] = useState(false);

  const onNodesChange = useCallback<OnNodesChange<Node<NData>>>(
    (changes: Array<NodeChange<Node<NData>>>) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
    },
    [],
  );

  const onEdgesChange = useCallback<OnEdgesChange>((changes: EdgeChange[]) => {
    setEdges((prev) => applyEdgeChanges(changes, prev));
  }, []);

  const doLayout = useCallback(async () => {
    setIsLayouting(true);
    try {
      const positioned = await computeLayout(rawNodes, rawEdges, layoutOpts);
      setNodes(positioned);
      setEdges(rawEdges);
      layoutDone.current = true;
      requestAnimationFrame(() => {
        void fitView({ padding: fitViewPadding, duration: fitViewDuration });
      });
    } catch {
      setNodes(rawNodes);
      setEdges(rawEdges);
    } finally {
      setIsLayouting(false);
    }
  }, [rawNodes, rawEdges, fitView, fitViewPadding, fitViewDuration]);

  useEffect(() => {
    if (!layoutDone.current || hasStructuralChange(nodes, rawNodes)) {
      void doLayout();
      return;
    }
    setNodes((prev) =>
      prev.map((n) => {
        const updated = rawNodes.find((r) => r.id === n.id);
        return updated ? { ...n, data: updated.data } : n;
      }),
    );
    setEdges(rawEdges);
  }, [rawNodes, rawEdges]);

  return { nodes, edges, onNodesChange, onEdgesChange, isLayouting, relayout: doLayout };
}

function hasStructuralChange(current: Array<{ id: string }>, next: Array<{ id: string }>): boolean {
  if (current.length !== next.length) return true;
  const currentIds = new Set(current.map((n) => n.id));
  return next.some((n) => !currentIds.has(n.id));
}
