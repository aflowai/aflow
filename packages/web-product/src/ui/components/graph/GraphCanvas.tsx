'use client';

import { useCallback, type CSSProperties, type ReactNode } from 'react';
import { useBreakpoint } from '@aflow/design-system';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type FitViewOptions,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useGraphLayout, type UseGraphLayoutOptions } from './useGraphLayout.js';

export interface GraphCanvasProps<NData extends Record<string, unknown>> {
  nodes: Array<Node<NData>>;
  edges: Edge[];
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes | undefined;
  selectedNodeId?: string | null | undefined;
  selectedEdgeId?: string | null | undefined;
  onSelectNode?: ((id: string | null) => void) | undefined;
  onSelectEdge?: ((id: string | null) => void) | undefined;
  onNodeDoubleClick?: ((id: string) => void) | undefined;
  onConnect?: ((connection: Connection) => void) | undefined;
  onKeyDown?: ((e: React.KeyboardEvent) => void) | undefined;
  /** Whether the canvas accepts new connections / drag edits. Default false. */
  editable?: boolean | undefined;
  /** Show the React Flow MiniMap. Default true. */
  showMiniMap?: boolean | undefined;
  /** Show the React Flow Controls. Default true. */
  showControls?: boolean | undefined;
  /** Override the ELK layout direction / spacing. */
  layoutOptions?: UseGraphLayoutOptions | undefined;
  /** Optional style overrides for the wrapper div. */
  style?: CSSProperties | undefined;
  /** Overlay rendered on top of the React Flow viewport (e.g. ripple layer). */
  children?: ReactNode | undefined;
  /** fitView padding / duration overrides. */
  fitViewOptions?: FitViewOptions | undefined;
  /** Canvas background colour. Defaults to surface-1. */
  canvasBackground?: string | undefined;
}

const DEFAULT_FIT_VIEW: FitViewOptions = { padding: 0.2 };

const EDGE_SVG_FIX = `
  .react-flow__edges,
  .react-flow__edges svg {
    width: 100% !important;
    height: 100% !important;
    overflow: visible !important;
  }
  .react-flow__connectionline {
    overflow: visible !important;
  }
    .react-flow__background {
      --xy-background-pattern-color-props: var(--color-surface-4) !important;
      /* Let the .react-flow root's inline \`background: canvasBackground\` show
         through — the pattern layer otherwise repaints the xyflow default over
         it, and painting an alpha background twice darkens it. */
      background-color: transparent !important;
    }
`;

function GraphCanvasInner<NData extends Record<string, unknown>>({
  nodes: rawNodes,
  edges: rawEdges,
  nodeTypes,
  edgeTypes,
  onSelectNode,
  onSelectEdge,
  onNodeDoubleClick,
  onConnect,
  onKeyDown,
  editable = false,
  showMiniMap = true,
  showControls = true,
  layoutOptions,
  style,
  children,
  fitViewOptions = DEFAULT_FIT_VIEW,
  canvasBackground = 'var(--color-surface-1)',
}: GraphCanvasProps<NData>) {
  const { isMobile } = useBreakpoint();
  const { nodes, edges, onNodesChange, onEdgesChange, isLayouting } = useGraphLayout(
    rawNodes,
    rawEdges,
    layoutOptions ?? {},
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!editable) return;
      onConnect?.(conn);
    },
    [editable, onConnect],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      onSelectNode?.(node.id);
    },
    [onSelectNode],
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: { id: string }) => {
      onSelectEdge?.(edge.id);
    },
    [onSelectEdge],
  );

  const handlePaneClick = useCallback(() => {
    onSelectNode?.(null);
    onSelectEdge?.(null);
  }, [onSelectNode, onSelectEdge]);

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      onNodeDoubleClick?.(node.id);
    },
    [onNodeDoubleClick],
  );

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative', ...style }}
      onKeyDown={onKeyDown}
      tabIndex={onKeyDown ? 0 : undefined}
    >
      <style dangerouslySetInnerHTML={{ __html: EDGE_SVG_FIX }} />
      {isLayouting && (
        <div
          style={{
            position: 'absolute',
            top: 'var(--space-3)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            background: 'var(--color-surface-1)',
            padding: 'var(--space-1) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          Laying out…
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        {...(edgeTypes ? { edgeTypes } : {})}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={{ hideAttribution: true }}
        snapToGrid
        snapGrid={[10, 10]}
        deleteKeyCode={null}
        elevateEdgesOnSelect
        colorMode="dark"
        defaultEdgeOptions={{ type: 'default' }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        style={{ background: canvasBackground }}
      >
        <Background color="var(--color-border-subtle)" gap={20} size={1} />
        {showControls && (
          <Controls
            style={{
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border-subtle)',
              overflow: 'hidden',
            }}
          />
        )}
        {showMiniMap && !isMobile && (
          <MiniMap
            nodeStrokeWidth={3}
            style={{
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border-subtle)',
              overflow: 'hidden',
            }}
          />
        )}
        {children}
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas<NData extends Record<string, unknown>>(props: GraphCanvasProps<NData>) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
