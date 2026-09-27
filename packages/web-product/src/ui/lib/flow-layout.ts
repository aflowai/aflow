/**
 * Auto-layout for flow graphs using ELK (Eclipse Layout Kernel).
 *
 * Converts React Flow nodes/edges into an ELK graph, runs the layout,
 * and returns updated node positions.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

/** Default node dimensions for layout calculation */
const NODE_WIDTH = 240;
const NODE_HEIGHT = 100;

export interface LayoutOptions {
  direction?: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
  /** Space between layers (along the main axis) */
  layerSpacing?: number;
  /** Space between sibling nodes (perpendicular to main axis) */
  nodeSpacing?: number;
  /** Padding inside the graph */
  padding?: number;
  /**
   * ELK node height (all nodes get the same bbox). Taller cards (e.g. process
   * map skills with goal + sparkline) should pass a larger value to avoid
   * overlap. Defaults to 100.
   */
  nodeHeight?: number;
  /**
   * ELK node width (all nodes get the same bbox). Wider cards (e.g. the skill
   * designer's enriched nodes) should pass a larger value to avoid overlap,
   * especially in horizontal (RIGHT) layouts. Defaults to 240.
   */
  nodeWidth?: number;
}

/**
 * Compute auto-layout positions for React Flow nodes using ELK.
 * Returns new nodes with updated positions.
 */
export async function computeLayout<T extends Record<string, unknown>>(
  nodes: Array<Node<T>>,
  edges: Edge[],
  options: LayoutOptions = {},
): Promise<Array<Node<T>>> {
  const {
    direction = 'DOWN',
    layerSpacing = 100,
    nodeSpacing = 60,
    padding = 40,
    nodeHeight = NODE_HEIGHT,
    nodeWidth = NODE_WIDTH,
  } = options;

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      // --- Algorithm ---
      'elk.algorithm': 'layered',
      'elk.direction': direction,

      // --- Spacing ---
      // Gap between sibling nodes within the same layer
      'elk.spacing.nodeNode': String(nodeSpacing),
      // Gap between layers (e.g. rows in a top-down layout)
      'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
      // Minimum gap between an edge and a node it passes by
      'elk.layered.spacing.edgeNodeBetweenLayers': String(layerSpacing * 0.4),
      // Gap between edges running in parallel
      'elk.spacing.edgeEdge': '20',
      'elk.spacing.edgeNode': '30',

      // --- Padding ---
      'elk.padding': `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,

      // --- Edge routing ---
      // SPLINES produces curved edges that match bezier paths better
      'elk.edgeRouting': 'SPLINES',

      // --- Node placement ---
      // BRANDES_KOEPF gives compact, balanced placement
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',

      // --- Crossing minimization ---
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      // Run extra passes for better results
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      // Use input order as a strong tie-breaker. Without this, unconnected
      // nodes (e.g. inactive trigger placeholders on the process map) end
      // up in arbitrary slots within their layer. With it, the order in
      // which nodes are passed to ELK is respected whenever the crossing
      // count is tied.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.considerModelOrder.crossingCounterNodeInfluence': '0.1',

      // --- Cycle handling (for loops like agent↔tool) ---
      'elk.layered.cycleBreaking.strategy': 'GREEDY',

      // --- Alignment & compaction ---
      'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',

      // --- Keep start node at the top ---
      'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: nodeWidth,
      height: nodeHeight,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(elkGraph);

  const positionMap = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    positionMap.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  return nodes.map((node) => {
    const pos = positionMap.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });
}
