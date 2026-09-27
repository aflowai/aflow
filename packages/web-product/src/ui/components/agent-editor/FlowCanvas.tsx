'use client';

/**
 * Agent editor canvas — a thin wrapper around the generic GraphCanvas kit
 * (apps/web/src/components/graph/) that adds agent-specific behaviour:
 *
 *   - Validation annotation on each StepNode (errorCount / warningCount)
 *   - Success vs failure handle routing on new connections
 *   - Delete key handling for the selected step or transition
 *
 * Pure visualisation lives in the kit; this file is the agent-domain seam.
 */

import { useCallback, useMemo } from 'react';
import type { NodeTypes } from '@xyflow/react';

import { StepNode } from './StepNode.js';
import { GraphCanvas } from '../graph/index.js';
import { flowToNodes, flowToEdges, type AgentDefinition } from '../../lib/flow-to-graph.js';
import { getStepIssues, type ValidationResult } from '../../lib/flow-validation.js';

const nodeTypes: NodeTypes = {
  stepNode: StepNode as unknown as NodeTypes['stepNode'],
};

interface FlowCanvasProps {
  flow: AgentDefinition;
  validation: ValidationResult;
  selectedStepId: string | null;
  selectedEdgeId: string | null;
  onSelectStep: (stepId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onAddTransition: (source: string, target: string, type?: 'success' | 'failure') => void;
  onRemoveStep?: ((stepId: string) => void) | undefined;
  onRemoveTransition?:
    ((source: string, target: string, type: 'success' | 'failure') => void) | undefined;
  /** If true, user can edit the graph */
  editable?: boolean | undefined;
}

export function FlowCanvas({
  flow,
  validation,
  selectedStepId,
  selectedEdgeId,
  onSelectStep,
  onSelectEdge,
  onAddTransition,
  onRemoveStep,
  onRemoveTransition,
  editable = true,
}: FlowCanvasProps) {
  const rawNodes = useMemo(() => {
    const nodes = flowToNodes(flow);
    return nodes.map((node) => {
      const issues = getStepIssues(validation, node.id);
      return {
        ...node,
        data: {
          ...node.data,
          errorCount: issues.filter((i) => i.level === 'error').length,
          warningCount: issues.filter((i) => i.level === 'warning').length,
        },
      };
    });
  }, [flow, validation]);

  const rawEdges = useMemo(() => flowToEdges(flow), [flow]);

  const handleConnect = useCallback(
    (connection: {
      source: string | null;
      target: string | null;
      sourceHandle?: string | null | undefined;
    }) => {
      if (!connection.source || !connection.target) return;
      const edgeType = connection.sourceHandle === 'failure' ? 'failure' : 'success';
      onAddTransition(connection.source, connection.target, edgeType);
    },
    [onAddTransition],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!editable) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (selectedStepId && onRemoveStep) {
        onRemoveStep(selectedStepId);
        return;
      }
      if (selectedEdgeId && onRemoveTransition) {
        const [from, edgeType, to] = selectedEdgeId.split('->');
        if (from !== undefined && edgeType !== undefined && to !== undefined) {
          onRemoveTransition(from, to, edgeType as 'success' | 'failure');
        }
      }
    },
    [editable, selectedStepId, selectedEdgeId, onRemoveStep, onRemoveTransition],
  );

  return (
    <GraphCanvas
      nodes={rawNodes}
      edges={rawEdges}
      nodeTypes={nodeTypes}
      selectedNodeId={selectedStepId}
      selectedEdgeId={selectedEdgeId}
      onSelectNode={onSelectStep}
      onSelectEdge={onSelectEdge}
      onConnect={handleConnect}
      onKeyDown={handleKeyDown}
      editable={editable}
    />
  );
}
