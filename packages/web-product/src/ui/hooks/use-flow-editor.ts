'use client';

import { useReducer, useCallback, useEffect } from 'react';
import {
  flowEditorReducer,
  createInitialEditorState,
  type FlowEditorState,
  type FlowEditorAction,
} from '../lib/flow-editor-reducer.js';
import type { AgentDefinition, StepDefinition, StateVariable } from '../lib/flow-to-graph.js';
import { useOperationCatalog } from './use-operation-catalog.js';

export interface UseFlowEditorReturn {
  state: FlowEditorState;
  dispatch: React.Dispatch<FlowEditorAction>;
  // Convenience methods
  undo: () => void;
  redo: () => void;
  addStep: (
    stepType: StepDefinition['stepType'],
    operation: StepDefinition['operation'],
    name?: string,
  ) => void;
  removeStep: (stepId: string) => void;
  updateStep: (stepId: string, patch: Partial<StepDefinition>) => void;
  selectStep: (stepId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  addTransition: (source: string, target: string, type?: 'success' | 'failure') => void;
  removeTransition: (source: string, target: string, type: 'success' | 'failure') => void;
  addVariable: (variable: StateVariable) => void;
  removeVariable: (variableId: string) => void;
  updateVariable: (variableId: string, patch: Partial<StateVariable>) => void;
  updateMetadata: (metadata: Partial<AgentDefinition['metadata']>) => void;
  setStartStep: (stepId: string) => void;
  markSaved: () => void;
  // Catalog
  catalog: ReturnType<typeof useOperationCatalog>;
}

export function useFlowEditor(initialFlow: AgentDefinition): UseFlowEditorReturn {
  const catalog = useOperationCatalog();
  const [state, dispatch] = useReducer(flowEditorReducer, createInitialEditorState(initialFlow));

  // Sync catalog into reducer when it loads
  useEffect(() => {
    if (catalog.operations.length > 0) {
      dispatch({
        type: 'SET_CATALOG',
        catalog: catalog.operations.map((op) => ({
          operationId: op.operationId,
          stepType: op.stepType,
          name: op.displayName,
          semanticDescription: op.description,
          inputSchema: op.inputSchema,
          outputSchema: op.outputSchema,
          internalFields: op.internalFields,
        })),
      });
    }
  }, [catalog.operations]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
      }
      if (meta && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'REDO' });
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return {
    state,
    dispatch,
    undo: useCallback(() => {
      dispatch({ type: 'UNDO' });
    }, []),
    redo: useCallback(() => {
      dispatch({ type: 'REDO' });
    }, []),
    addStep: useCallback(
      (
        stepType: StepDefinition['stepType'],
        operation: StepDefinition['operation'],
        name?: string,
      ) => {
        dispatch({ type: 'ADD_STEP', stepType, operation, name });
      },
      [],
    ),
    removeStep: useCallback((stepId: string) => {
      dispatch({ type: 'REMOVE_STEP', stepId });
    }, []),
    updateStep: useCallback((stepId: string, patch: Partial<StepDefinition>) => {
      dispatch({ type: 'UPDATE_STEP', stepId, patch });
    }, []),
    selectStep: useCallback((stepId: string | null) => {
      dispatch({ type: 'SELECT_STEP', stepId });
    }, []),
    selectEdge: useCallback((edgeId: string | null) => {
      dispatch({ type: 'SELECT_EDGE', edgeId });
    }, []),
    addTransition: useCallback((source: string, target: string, type?: 'success' | 'failure') => {
      dispatch({
        type: 'ADD_TRANSITION',
        sourceStepId: source,
        targetStepId: target,
        edgeType: type,
      });
    }, []),
    removeTransition: useCallback((source: string, target: string, type: 'success' | 'failure') => {
      dispatch({
        type: 'REMOVE_TRANSITION',
        sourceStepId: source,
        targetStepId: target,
        edgeType: type,
      });
    }, []),
    addVariable: useCallback((variable: StateVariable) => {
      dispatch({ type: 'ADD_VARIABLE', variable });
    }, []),
    removeVariable: useCallback((variableId: string) => {
      dispatch({ type: 'REMOVE_VARIABLE', variableId });
    }, []),
    updateVariable: useCallback((variableId: string, patch: Partial<StateVariable>) => {
      dispatch({ type: 'UPDATE_VARIABLE', variableId, patch });
    }, []),
    updateMetadata: useCallback((metadata: Partial<AgentDefinition['metadata']>) => {
      dispatch({ type: 'UPDATE_METADATA', metadata });
    }, []),
    setStartStep: useCallback((stepId: string) => {
      dispatch({ type: 'SET_START_STEP', stepId });
    }, []),
    markSaved: useCallback(() => {
      dispatch({ type: 'MARK_SAVED' });
    }, []),
    catalog,
  };
}
