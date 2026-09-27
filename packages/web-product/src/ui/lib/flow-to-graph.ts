/**
 * Convert AgentDefinition ↔ React Flow nodes/edges.
 *
 * The AgentDefinition is the single source of truth.
 * This module provides bidirectional mapping so the graph canvas
 * can render the flow and edits can be applied back to the definition.
 */

import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type {
  AgentDefinition,
  StepDefinition,
  StateVariable,
  NextStepEdge,
  OutputOptions,
  AgentSlug,
  OperationId,
  StepId,
  StepType,
} from '@aflow/schemas';

// Re-export schema types so existing consumers can keep importing from here.
export type { AgentDefinition, StepDefinition, StateVariable, NextStepEdge, OutputOptions };

// ---------------------------------------------------------------------------
// Step type → icon/color mapping (used by the custom node)
// ---------------------------------------------------------------------------

export const STEP_TYPE_META: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI', color: 'var(--color-interactive-default)' },
  memory: { label: 'Memory', color: 'var(--color-info-default)' },
  api: { label: 'API', color: 'var(--color-warning-default)' },
  compute: { label: 'Compute', color: 'var(--color-success-default)' },
  search: { label: 'Search', color: 'var(--color-interactive-secondary)' },
  flowControl: { label: 'Flow Control', color: 'var(--color-text-muted)' },
  user: { label: 'User', color: 'var(--color-info-default)' },
  platform: { label: 'Platform', color: 'var(--color-text-secondary)' },
};

// ---------------------------------------------------------------------------
// Node data type
// ---------------------------------------------------------------------------

export interface StepNodeData extends Record<string, unknown> {
  step: StepDefinition;
  isStartStep: boolean;
  isTerminal: boolean;
  /** Number of validation errors on this step */
  errorCount: number;
  /** Number of validation warnings on this step */
  warningCount: number;
  /** Binding summaries */
  inputVars: string[];
  outputVars: string[];
}

// ---------------------------------------------------------------------------
// AgentDefinition → React Flow nodes + edges
// ---------------------------------------------------------------------------

export function flowToNodes(flow: AgentDefinition): Array<Node<StepNodeData>> {
  const steps = flow.steps ?? [];
  const terminalStepIds = new Set<string>();

  for (const step of steps) {
    const hasSuccessTarget = (step.onSuccess?.next ?? []).some((e) => e.stepId !== null);
    if (!hasSuccessTarget) {
      terminalStepIds.add(step.stepId);
    }
  }

  return steps.map((step, index) => ({
    id: step.stepId,
    type: 'stepNode',
    position: { x: 0, y: index * 160 },
    data: {
      step,
      isStartStep: step.stepId === flow.startStepId,
      isTerminal: terminalStepIds.has(step.stepId),
      errorCount: 0,
      warningCount: 0,
      inputVars: extractConfigRefs(step.config ?? {}),
      outputVars: Object.values(step.outputMapping ?? {}),
    },
  }));
}

/** Common marker for success / condition edges */
const SUCCESS_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 20,
  height: 20,
  color: '#5c854f40',
};

/** Marker for failure edges */
const FAILURE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 20,
  height: 20,
  color: '#ef444436',
};

/** Marker for resume edges */
const RESUME_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 20,
  height: 20,
  color: '#3b82f6',
};

export function flowToEdges(flow: AgentDefinition): Edge[] {
  const edges: Edge[] = [];

  const steps = flow.steps ?? [];
  // Build a lookup so we can validate targets exist
  const stepIds = new Set(steps.map((s) => s.stepId));

  for (const step of steps) {
    // Success edges
    const successNext = step.onSuccess?.next ?? [];
    for (const edge of successNext) {
      if (edge.stepId && stepIds.has(edge.stepId)) {
        const hasCondition = Boolean(edge.when);
        edges.push({
          id: `${step.stepId}->success->${edge.stepId}`,
          source: step.stepId,
          target: edge.stepId,
          sourceHandle: 'success',
          type: 'default',
          label: edge.when ?? edge.description ?? undefined,
          style: {
            stroke: hasCondition ? '#a78bfa' : '#5c854f40',
            strokeWidth: 1,
            ...(hasCondition ? { strokeDasharray: '6 1' } : {}),
          },
          markerEnd: SUCCESS_MARKER,
          data: {
            edgeType: 'success' as const,
            condition: edge.when,
            priority: edge.priority,
            description: edge.description,
          },
        });
      }
    }

    // Failure edges
    const failureNext = step.onFailure?.next ?? [];
    for (const edge of failureNext) {
      if (edge.stepId && stepIds.has(edge.stepId)) {
        edges.push({
          id: `${step.stepId}->failure->${edge.stepId}`,
          source: step.stepId,
          target: edge.stepId,
          sourceHandle: 'failure',
          type: 'default',
          label: edge.description,
          style: {
            stroke: '#ef444436',
            strokeWidth: 1,
            strokeDasharray: '6 1',
          },
          markerEnd: FAILURE_MARKER,
          data: {
            edgeType: 'failure' as const,
            condition: edge.when,
            priority: edge.priority,
            description: edge.description,
          },
        });
      }
    }

    // Resume edges
    if (step.onResume?.continueToStepId && stepIds.has(step.onResume.continueToStepId)) {
      edges.push({
        id: `${step.stepId}->resume->${step.onResume.continueToStepId}`,
        source: step.stepId,
        target: step.onResume.continueToStepId,
        sourceHandle: 'resume',
        type: 'default',
        style: {
          stroke: '#3b82f6',
          strokeWidth: 1,
          strokeDasharray: '4 1',
        },
        markerEnd: RESUME_MARKER,
        data: {
          edgeType: 'resume' as const,
        },
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// React Flow changes → AgentDefinition mutations
// ---------------------------------------------------------------------------

/**
 * Apply node position changes back to the flow (we don't store positions in AgentDefinition,
 * they are managed by the layout engine or stored separately).
 * This is a no-op for the data model but useful for persisting layout.
 */
export type NodePositions = Record<string, { x: number; y: number }>;

/**
 * Add a new step to a flow.
 */
export function addStep(
  flow: AgentDefinition,
  stepType: StepType,
  operation: OperationId,
  name?: string,
): AgentDefinition {
  const stepId = generateStepId(flow, stepType) as StepId;
  const newStep: StepDefinition = {
    stepId,
    stepType,
    operation,
    name: name ?? `${stepType} step`,
    config: {},
    optional: false,
    tags: [],
    onSuccess: { next: [] },
    onFailure: { next: [] },
  };

  // Auto-connect: find the last terminal step (has no success transitions)
  // and wire it to the new step. This keeps the flow connected by default.
  const updatedSteps = flow.steps.map((s) => {
    if (s.onSuccess.next.length === 0) {
      return {
        ...s,
        onSuccess: { next: [{ stepId, priority: 50 }] },
      };
    }
    return s;
  });

  // If there are no steps yet, set the new step as the start step
  const startStepId = flow.steps.length === 0 ? stepId : flow.startStepId;

  return {
    ...flow,
    steps: [...updatedSteps, newStep],
    startStepId,
  };
}

/**
 * Remove a step and clean up all transitions pointing to it.
 */
export function removeStep(flow: AgentDefinition, stepId: string): AgentDefinition {
  const steps = flow.steps
    .filter((s) => s.stepId !== stepId)
    .map((s) => ({
      ...s,
      onSuccess: {
        next: s.onSuccess.next.filter((e) => e.stepId !== stepId),
      },
      onFailure: {
        next: s.onFailure.next.filter((e) => e.stepId !== stepId),
      },
      onResume: s.onResume?.continueToStepId === stepId ? undefined : s.onResume,
    }));

  return {
    ...flow,
    steps,
    startStepId:
      flow.startStepId === stepId ? (steps[0]?.stepId ?? flow.startStepId) : flow.startStepId,
  };
}

/**
 * Update a step in the flow.
 */
export function updateStep(
  flow: AgentDefinition,
  stepId: string,
  patch: Partial<StepDefinition>,
): AgentDefinition {
  return {
    ...flow,
    steps: flow.steps.map((s) => (s.stepId === stepId ? { ...s, ...patch } : s)),
  };
}

/**
 * Add a transition between two steps.
 */
export function addTransition(
  flow: AgentDefinition,
  sourceStepId: string,
  targetStepId: string,
  type: 'success' | 'failure' = 'success',
): AgentDefinition {
  return {
    ...flow,
    steps: flow.steps.map((s) => {
      if (s.stepId !== sourceStepId) return s;
      const edgeList = type === 'success' ? s.onSuccess.next : s.onFailure.next;
      // Don't add duplicate
      if (edgeList.some((e) => e.stepId === targetStepId)) return s;
      const newEdge: NextStepEdge = { stepId: targetStepId as StepId, priority: 50 };
      if (type === 'success') {
        return { ...s, onSuccess: { next: [...edgeList, newEdge] } };
      }
      return { ...s, onFailure: { next: [...edgeList, newEdge] } };
    }),
  };
}

/**
 * Remove a transition between two steps.
 */
export function removeTransition(
  flow: AgentDefinition,
  sourceStepId: string,
  targetStepId: string,
  type: 'success' | 'failure',
): AgentDefinition {
  return {
    ...flow,
    steps: flow.steps.map((s) => {
      if (s.stepId !== sourceStepId) return s;
      if (type === 'success') {
        return {
          ...s,
          onSuccess: { next: s.onSuccess.next.filter((e) => e.stepId !== targetStepId) },
        };
      }
      return {
        ...s,
        onFailure: { next: s.onFailure.next.filter((e) => e.stepId !== targetStepId) },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractConfigRefs(config: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const val of Object.values(config)) {
    if (typeof val === 'string') {
      const matches = val.matchAll(/\$\{([^}]+)\}/g);
      for (const m of matches) {
        if (m[1]) refs.push(m[1]);
      }
    }
  }
  return refs;
}

function generateStepId(flow: AgentDefinition, stepType: string): string {
  const existing = new Set(flow.steps.map((s) => s.stepId));
  // StepId must be lowercase (regex: ^[a-z][a-z0-9_-]*$)
  const base = stepType.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  let i = 1;
  let id = `${base}-${String(i)}`;
  while (existing.has(id as StepId)) {
    i++;
    id = `${base}-${String(i)}`;
  }
  return id;
}

/**
 * Create a minimal blank flow definition.
 */
export function createBlankFlow(flowId?: string): AgentDefinition {
  const id = (flowId ?? `flow-${String(Date.now())}`) as AgentSlug;
  return {
    schemaVersion: 1,
    flowId: id,
    systemRole: null,
    version: '1',
    metadata: {
      name: 'New Flow',
      description: '',
      tags: [],
      custom: {},
      public: false,
      system: false,
    },
    stateVariables: [],
    steps: [
      {
        stepId: 'start' as StepId,
        stepType: 'ai',
        operation: 'ai.chat' as StepDefinition['operation'],
        name: 'Start',
        config: {},
        optional: false,
        tags: [],
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
    ],
    startStepId: 'start' as StepId,
    allowedOperations: [],
    supportedModes: ['chat'],
    status: 'draft',
  };
}
