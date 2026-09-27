/**
 * Pure reducer for the flow editor state.
 * Manages undo/redo, validation, and all flow mutations.
 */

import type { AgentDefinition, StepDefinition, StateVariable } from './flow-to-graph.js';
import type { StepId } from '@aflow/schemas';
import {
  addStep,
  removeStep,
  updateStep,
  addTransition,
  removeTransition,
} from './flow-to-graph.js';
import {
  validateFlow,
  type ValidationResult,
  type OperationCatalogEntry,
} from './flow-validation.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface FlowEditorState {
  /** Current flow definition */
  flow: AgentDefinition;
  /** Undo stack (previous states) */
  undoStack: AgentDefinition[];
  /** Redo stack */
  redoStack: AgentDefinition[];
  /** Current validation result */
  validation: ValidationResult;
  /** Currently selected node ID */
  selectedStepId: string | null;
  /** Currently selected edge ID */
  selectedEdgeId: string | null;
  /** Whether the flow has unsaved changes */
  isDirty: boolean;
  /** Operation catalog for validation */
  catalog: OperationCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type FlowEditorAction =
  | { type: 'INIT'; flow: AgentDefinition; catalog?: OperationCatalogEntry[] }
  | { type: 'SET_CATALOG'; catalog: OperationCatalogEntry[] }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  // Flow-level mutations
  | { type: 'UPDATE_METADATA'; metadata: Partial<AgentDefinition['metadata']> }
  | { type: 'SET_START_STEP'; stepId: string }
  | {
      type: 'UPDATE_FLOW_SETTINGS';
      patch: Partial<
        Pick<
          AgentDefinition,
          'supportedModes' | 'defaultBudgets' | 'allowedOperations' | 'inputSchema' | 'outputSchema'
        >
      >;
    }
  // Step mutations
  | {
      type: 'ADD_STEP';
      stepType: StepDefinition['stepType'];
      operation: StepDefinition['operation'];
      name?: string | undefined;
    }
  | { type: 'REMOVE_STEP'; stepId: string }
  | { type: 'UPDATE_STEP'; stepId: string; patch: Partial<StepDefinition> }
  // Transition mutations
  | {
      type: 'ADD_TRANSITION';
      sourceStepId: string;
      targetStepId: string;
      edgeType?: 'success' | 'failure' | undefined;
    }
  | {
      type: 'REMOVE_TRANSITION';
      sourceStepId: string;
      targetStepId: string;
      edgeType: 'success' | 'failure';
    }
  // Variable mutations
  | { type: 'ADD_VARIABLE'; variable: StateVariable }
  | { type: 'REMOVE_VARIABLE'; variableId: string }
  | { type: 'UPDATE_VARIABLE'; variableId: string; patch: Partial<StateVariable> }
  // Selection
  | { type: 'SELECT_STEP'; stepId: string | null }
  | { type: 'SELECT_EDGE'; edgeId: string | null }
  // Publish feedback
  | { type: 'MARK_SAVED' };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const MAX_UNDO = 50;

export function flowEditorReducer(
  state: FlowEditorState,
  action: FlowEditorAction,
): FlowEditorState {
  switch (action.type) {
    case 'INIT': {
      const catalog = action.catalog ?? state.catalog;
      return {
        flow: action.flow,
        undoStack: [],
        redoStack: [],
        validation: validateFlow(action.flow, catalog),
        selectedStepId: null,
        selectedEdgeId: null,
        isDirty: false,
        catalog,
      };
    }

    case 'SET_CATALOG': {
      return {
        ...state,
        catalog: action.catalog,
        validation: validateFlow(state.flow, action.catalog),
      };
    }

    case 'UNDO': {
      const prev = state.undoStack[state.undoStack.length - 1];
      if (prev === undefined) return state;
      return {
        ...state,
        flow: prev,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, state.flow],
        validation: validateFlow(prev, state.catalog),
        isDirty: true,
      };
    }

    case 'REDO': {
      const next = state.redoStack[state.redoStack.length - 1];
      if (next === undefined) return state;
      return {
        ...state,
        flow: next,
        undoStack: [...state.undoStack, state.flow],
        redoStack: state.redoStack.slice(0, -1),
        validation: validateFlow(next, state.catalog),
        isDirty: true,
      };
    }

    case 'UPDATE_METADATA': {
      const newFlow = {
        ...state.flow,
        metadata: { ...state.flow.metadata, ...action.metadata },
      };
      return applyFlowEdit(state, newFlow);
    }

    case 'SET_START_STEP': {
      const newFlow = { ...state.flow, startStepId: action.stepId as StepId };
      return applyFlowEdit(state, newFlow);
    }

    case 'UPDATE_FLOW_SETTINGS': {
      const newFlow = { ...state.flow, ...action.patch };
      return applyFlowEdit(state, newFlow);
    }

    case 'ADD_STEP': {
      const newFlow = addStep(state.flow, action.stepType, action.operation, action.name);
      const newStepId = newFlow.steps[newFlow.steps.length - 1]?.stepId ?? null;
      return {
        ...applyFlowEdit(state, newFlow),
        selectedStepId: newStepId,
        selectedEdgeId: null,
      };
    }

    case 'REMOVE_STEP': {
      const newFlow = removeStep(state.flow, action.stepId);
      return {
        ...applyFlowEdit(state, newFlow),
        selectedStepId: state.selectedStepId === action.stepId ? null : state.selectedStepId,
      };
    }

    case 'UPDATE_STEP': {
      const newFlow = updateStep(state.flow, action.stepId, action.patch);
      return applyFlowEdit(state, newFlow);
    }

    case 'ADD_TRANSITION': {
      const newFlow = addTransition(
        state.flow,
        action.sourceStepId,
        action.targetStepId,
        action.edgeType ?? 'success',
      );
      return applyFlowEdit(state, newFlow);
    }

    case 'REMOVE_TRANSITION': {
      const newFlow = removeTransition(
        state.flow,
        action.sourceStepId,
        action.targetStepId,
        action.edgeType,
      );
      return applyFlowEdit(state, newFlow);
    }

    case 'ADD_VARIABLE': {
      const newFlow = {
        ...state.flow,
        stateVariables: [...state.flow.stateVariables, action.variable],
      };
      return applyFlowEdit(state, newFlow);
    }

    case 'REMOVE_VARIABLE': {
      const newFlow = {
        ...state.flow,
        stateVariables: state.flow.stateVariables.filter((v) => v.variableId !== action.variableId),
      };
      return applyFlowEdit(state, newFlow);
    }

    case 'UPDATE_VARIABLE': {
      const newFlow = {
        ...state.flow,
        stateVariables: state.flow.stateVariables.map((v) =>
          v.variableId === action.variableId ? { ...v, ...action.patch } : v,
        ),
      };
      return applyFlowEdit(state, newFlow);
    }

    case 'SELECT_STEP':
      return { ...state, selectedStepId: action.stepId, selectedEdgeId: null };

    case 'SELECT_EDGE':
      return { ...state, selectedEdgeId: action.edgeId, selectedStepId: null };

    case 'MARK_SAVED':
      return { ...state, isDirty: false };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyFlowEdit(state: FlowEditorState, newFlow: AgentDefinition): FlowEditorState {
  const undoStack =
    state.undoStack.length >= MAX_UNDO
      ? [...state.undoStack.slice(1), state.flow]
      : [...state.undoStack, state.flow];

  return {
    ...state,
    flow: newFlow,
    undoStack,
    redoStack: [], // Clear redo on new edit
    validation: validateFlow(newFlow, state.catalog),
    isDirty: true,
  };
}

/**
 * Create initial editor state from a flow definition.
 */
export function createInitialEditorState(
  flow: AgentDefinition,
  catalog?: OperationCatalogEntry[],
): FlowEditorState {
  return {
    flow,
    undoStack: [],
    redoStack: [],
    validation: validateFlow(flow, catalog),
    selectedStepId: null,
    selectedEdgeId: null,
    isDirty: false,
    catalog: catalog ?? [],
  };
}
