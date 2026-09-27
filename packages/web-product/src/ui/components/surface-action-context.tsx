'use client';

import { createContext, useContext, useCallback } from 'react';
import type { SurfaceAction } from './surface-renderer/index.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import type { RunViewAction } from '@aflow/run-view';

interface SurfaceActionContextValue {
  /** Dispatch a surface action (button click, form submit, etc.) */
  onSurfaceAction: (action: SurfaceAction) => void;
}

const SurfaceActionContext = createContext<SurfaceActionContextValue | null>(null);

export function useSurfaceAction(): SurfaceActionContextValue | null {
  return useContext(SurfaceActionContext);
}

/** Derive a human-readable label from a component ID (e.g., "btn_great" → "Great") */
function humanizeComponentId(id: string): string {
  return id
    .replace(/^btn_|^button_|^action_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface SurfaceActionProviderProps {
  runId: string | null;
  stepExecutionId: string | null;
  /** Dispatch to run view reducer for optimistic messages */
  dispatch?: React.Dispatch<RunViewAction>;
  children: React.ReactNode;
}

/**
 * Provides surface action handling to descendant ContentRenderers.
 * When a surface button/form fires an action, this resumes the paused run
 * with the action payload as input.
 */
export function SurfaceActionProvider({
  runId,
  stepExecutionId,
  dispatch,
  children,
}: SurfaceActionProviderProps) {
  const { mutateAsync: resumeWithAction } = useApiMutation<{
    sessionId: string;
    body: { stepExecutionId: string; input: { input: string }; clientMessageId: string };
  }>({
    path: (i) => `/sessions/${i.sessionId}/resume`,
    serialize: (i) => JSON.stringify(i.body),
  });

  const onSurfaceAction = useCallback(
    (action: SurfaceAction) => {
      if (!runId || !stepExecutionId) {
        console.warn('[surface-action] Cannot dispatch: no active run or step', {
          runId,
          stepExecutionId,
        });
        return;
      }

      const label = humanizeComponentId(action.componentId);

      // Format the action as a chat message the agent can understand.
      // Include the humanized label as the selected value so the agent
      // doesn't have to parse component IDs.
      const toStr = (v: unknown) =>
        typeof v === 'object' && v !== null
          ? JSON.stringify(v)
          : String((v ?? '') as string | number | boolean);
      const agentMessage = action.action['eventName']
        ? `User selected "${label}" (component: ${toStr(action.componentId)}, action: ${toStr(action.action['eventName'])})`
        : `User clicked "${label}" (component: ${toStr(action.componentId)})`;

      // Dispatch optimistic user message with surface_action semantic type
      // so the chat UI renders it as a compact action chip. The chip id
      // round-trips as `clientMessageId` so the server's SessionResumed
      // reconstruction dedups exactly and keeps the chip rendering
      // (id-prefix branch in ChatMessages).
      const chipId = `surface-action-${crypto.randomUUID()}`;
      if (dispatch) {
        dispatch({
          type: 'USER_MESSAGE',
          content: label,
          id: chipId,
          timestamp: new Date().toISOString(),
        });
      }

      void resumeWithAction({
        sessionId: runId,
        body: {
          stepExecutionId,
          input: { input: agentMessage },
          clientMessageId: chipId,
        },
      })
        .then(() => {
          if (dispatch) {
            dispatch({ type: 'LOCAL_RUN_STATE', status: 'RUNNING', requiredInput: null });
          }
        })
        .catch((err: unknown) => {
          console.error('[surface-action] Failed to resume run with action:', err);
        });
    },
    [runId, stepExecutionId, resumeWithAction, dispatch],
  );

  return (
    <SurfaceActionContext.Provider value={{ onSurfaceAction }}>
      {children}
    </SurfaceActionContext.Provider>
  );
}
