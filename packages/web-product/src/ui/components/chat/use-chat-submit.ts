'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { triggerCyberneticRefresh } from '../cybernetic-provider.js';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { ApiError } from '../../lib/query-client.js';
import type { RunViewAction, RunViewState } from '@aflow/run-view';
import type {
  ConversationItem,
  Flow,
  Session,
  SessionSeed,
  WorkflowRunSurfaceState,
} from '../../lib/types.js';
import { snapshotTerminalSegmentItems } from './conversation-items.js';

function flowToSessionTarget(
  flow: Flow,
): { kind: 'platform-role'; systemRole: string } | { kind: 'custom-agent'; agentId: string } {
  if (flow.systemRole) {
    return { kind: 'platform-role', systemRole: flow.systemRole };
  }
  return { kind: 'custom-agent', agentId: flow.agentId };
}

interface StartSessionBody {
  target: ReturnType<typeof flowToSessionTarget>;
  input: Record<string, unknown>;
  mode: 'chat';
  clientMessageId: string;
  /** Space members invited as the session is born — the compose-time picker. */
  invitees?: string[];
  /**
   * What this run pins its simulated worlds to, when the chat was opened from
   * a rehearsal link. Set here rather than anywhere the agent can reach: a
   * subject choosing its own persona or world version is choosing the
   * environment it is measured in.
   *
   * It rides the START call only. The pin is fixed for the run's life, so
   * there is nothing to send on a resume.
   */
  simulationRunInput?: Record<string, unknown>;
}

interface StartSessionResult {
  sessionId: string;
  status: string;
  requiredInput?: Session['requiredInput'];
}

interface ResumeSessionInput {
  sessionId: string;
  body: {
    stepExecutionId: string;
    input: Record<string, unknown>;
    clientMessageId: string;
  };
}

export interface UseChatSubmitParams {
  selectedFlow: Flow | null;
  /** Route space id — needed for the space-scoped workflow.run.pause route. */
  spaceId: string;
  /** Identity seed only — read for `sessionId`; never for status/requiredInput. */
  currentRun: SessionSeed | null;
  setCurrentRun: React.Dispatch<React.SetStateAction<SessionSeed | null>>;
  effectiveStatus: string | null;
  effectiveRequiredInput: Session['requiredInput'] | null | undefined;
  blockedOn: RunViewState['blockedOn'];
  isTerminalStatus: boolean;
  dispatch: React.Dispatch<RunViewAction>;
  reconnectSSE: () => void;
  reducerState: RunViewState;
  setPastItems: React.Dispatch<React.SetStateAction<ConversationItem[]>>;
  setPastWorkflowRuns: React.Dispatch<
    React.SetStateAction<Record<string, WorkflowRunSurfaceState>>
  >;
  setOptimisticThinking: React.Dispatch<React.SetStateAction<string | undefined>>;
  /** People picked before the session exists; ride the start call as invitations. */
  draftInvitees?: string[];
  /** Present only when this chat was opened from a rehearsal link. */
  simulationRunInput?: Record<string, unknown> | undefined;
}

export function useChatSubmit({
  selectedFlow,
  spaceId,
  currentRun,
  setCurrentRun,
  effectiveStatus,
  effectiveRequiredInput,
  blockedOn,
  isTerminalStatus,
  dispatch,
  reconnectSSE,
  reducerState,
  setPastItems,
  setPastWorkflowRuns,
  setOptimisticThinking,
  draftInvitees,
  simulationRunInput,
}: UseChatSubmitParams) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const reducerStateRef = useRef(reducerState);
  reducerStateRef.current = reducerState;

  const { mutateAsync: startSessionMutate } = useApiMutation<StartSessionBody, StartSessionResult>({
    path: '/sessions',
    // A new session row appears in the recent-runs list (history pane).
    invalidate: [['space', spaceId, 'sessions']],
  });
  const { mutateAsync: resumeSessionMutate } = useApiMutation<ResumeSessionInput, Session>({
    path: (i) => `/sessions/${i.sessionId}/resume`,
    serialize: (i) => JSON.stringify(i.body),
  });
  const { mutateAsync: interruptSessionMutate } = useApiMutation<
    { sessionId: string },
    { status?: string } | undefined
  >({
    path: (i) => `/sessions/${i.sessionId}/interrupt`,
    serialize: () => JSON.stringify({}),
  });
  const { mutateAsync: retrySessionMutate } = useApiMutation<{
    sessionId: string;
    input?: Record<string, unknown>;
  }>({
    path: (i) => `/sessions/${i.sessionId}/retry`,
    serialize: (i) => JSON.stringify(i.input ? { input: i.input } : {}),
  });
  const { mutateAsync: pauseWorkflowRunMutate } = useApiMutation<{ runId: string }>({
    path: (i) => `/spaces/${spaceId}/workflow-runs/${i.runId}/pause`,
    serialize: () => JSON.stringify({}),
  });

  // Bug 2 (2026-05-29): when a user submits while the run is still RUNNING or
  // is transiently PAUSED without a resume contract yet (interrupt in flight,
  // SSE `SessionPaused` not arrived), the old code POSTed `/sessions` and
  // silently started a *new* session. Queue the pending message and fire the
  // resume the moment `effectiveRequiredInput.stepExecutionId` lands.
  //
  const pendingResumeRef = useRef<{
    sessionId: string;
    content: string;
    config?: Record<string, unknown>;
    msgId: string;
  } | null>(null);
  const [queuedMessageId, setQueuedMessageId] = useState<string | null>(null);

  const buildInput = useCallback(
    (content: string, config?: Record<string, unknown>): Record<string, unknown> => ({
      input: content,
      ...(config && Object.keys(config).length > 0 ? { config } : {}),
    }),
    [],
  );

  const retryRun = useCallback(
    async (input?: Record<string, unknown>) => {
      if (!currentRun || effectiveStatus !== 'FAILED') return;
      setIsSubmitting(true);
      try {
        await retrySessionMutate({
          sessionId: currentRun.sessionId,
          ...(input ? { input } : {}),
        });
        reconnectSSE();
        dispatch({
          type: 'LOCAL_RUN_STATE',
          status: 'RUNNING',
          requiredInput: null,
          clearError: true,
        });
      } catch {
        dispatch({
          type: 'SUBMIT_ERROR',
          error: 'Failed to retry. Please try again.',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [currentRun, effectiveStatus, retrySessionMutate, dispatch, reconnectSSE],
  );

  const cancelRun = useCallback(async () => {
    if (!currentRun || isInterrupting) return;
    setIsInterrupting(true);
    try {
      const body = await interruptSessionMutate({ sessionId: currentRun.sessionId });
      void triggerCyberneticRefresh();
      if (body?.status && body.status !== 'RUNNING' && body.status !== 'QUEUED') {
        dispatch({ type: 'LOCAL_RUN_STATE', status: body.status });
        setIsInterrupting(false);
      }
      // RUNNING/QUEUED → stay "interrupting"; the status-edge effect in the
      // chat page resets the flag when the SSE transition lands.
    } catch (err) {
      // HTTP errors carry the server's view of the session; the interrupt
      // endpoint reports `currentStatus` on conflict (e.g. already terminal).
      if (err instanceof ApiError) {
        void triggerCyberneticRefresh();
        const currentStatus =
          err.body && typeof err.body === 'object' && 'currentStatus' in err.body
            ? (err.body as { currentStatus?: string }).currentStatus
            : undefined;
        if (currentStatus) {
          dispatch({ type: 'LOCAL_RUN_STATE', status: currentStatus });
        }
      }
      setIsInterrupting(false);
    }
  }, [currentRun, dispatch, interruptSessionMutate, isInterrupting]);

  const pauseRun = useCallback(async () => {
    const runId = blockedOn?.kind === 'workflow_run' ? blockedOn.runId : null;
    if (!runId || !spaceId || isInterrupting) return;
    setIsInterrupting(true);
    try {
      await pauseWorkflowRunMutate({ runId });
      void triggerCyberneticRefresh();
    } catch (err) {
      // HTTP-level failures still poke the cybernetic refresh (server state
      // may have moved); network failures don't.
      if (err instanceof ApiError) void triggerCyberneticRefresh();
    } finally {
      setIsInterrupting(false);
    }
  }, [blockedOn, isInterrupting, pauseWorkflowRunMutate, spaceId]);

  const handleSubmit = useCallback(
    async (content: string, config?: Record<string, unknown>) => {
      if (!content.trim() || !selectedFlow) return;
      if (blockedOn?.kind === 'workflow_run') return;
      setIsSubmitting(true);
      setOptimisticThinking('Processing…');

      const msgId = crypto.randomUUID();

      try {
        if (effectiveStatus === 'FAILED' && currentRun) {
          dispatch({
            type: 'USER_MESSAGE',
            content,
            id: msgId,
            timestamp: new Date().toISOString(),
          });
          await retryRun(buildInput(content, config));
          return;
        }

        if (isTerminalStatus && currentRun && effectiveStatus != null) {
          const userMsg = {
            id: msgId,
            role: 'user' as const,
            content,
            timestamp: new Date().toISOString(),
          };

          const sepId = `sep-${currentRun.sessionId}`;
          setPastItems((prev) => {
            const alreadySnapshotted = prev.some(
              (item) => item.kind === 'run-separator' && item.id === sepId,
            );
            return [
              ...prev,
              ...snapshotTerminalSegmentItems({
                reducer: reducerStateRef.current,
                currentRun,
                effectiveStatus,
                userMsg,
                alreadySnapshotted,
                pastItems: prev,
              }),
            ];
          });

          setPastWorkflowRuns((prev) => {
            const rs = reducerStateRef.current;
            const merged = { ...prev };
            for (const [runId, runState] of Object.entries(rs.workflowRuns)) {
              if (runState.isFrozen) {
                merged[runId] = runState;
              }
            }
            return merged;
          });

          const data = await startSessionMutate({
            target: flowToSessionTarget(selectedFlow),
            input: buildInput(content, config),
            mode: 'chat',
            clientMessageId: msgId,
            ...(draftInvitees && draftInvitees.length > 0 ? { invitees: draftInvitees } : {}),
            ...(simulationRunInput ? { simulationRunInput } : {}),
          });
          // Identity seed only — mutable state goes through the reducer.
          // No LOCAL_RUN_STATE seed here: the session switch makes
          // use-run-reducer dispatch RESET (wiping any local seed) and
          // re-hydrate from the snapshot, which carries the POST-time
          // SessionQueued fold.
          setCurrentRun({
            sessionId: data.sessionId,
            agentId: selectedFlow.agentId,
            agentVersion: selectedFlow.latestVersion,
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const isPaused = effectiveStatus === 'PAUSED';
        const resumeStepExecId = effectiveRequiredInput?.stepExecutionId;
        const willDirectResume = Boolean(currentRun && isPaused && resumeStepExecId);
        const willQueue =
          !willDirectResume &&
          Boolean(
            currentRun &&
            (effectiveStatus === 'RUNNING' ||
              effectiveStatus === 'QUEUED' ||
              effectiveStatus === 'WAITING_ON_CHILD' ||
              isPaused),
          );

        dispatch({
          type: 'USER_MESSAGE',
          content,
          id: msgId,
          timestamp: new Date().toISOString(),
          deliveryState: willQueue ? 'queued' : 'delivering',
        });

        if (currentRun && isPaused && resumeStepExecId) {
          try {
            const data = await resumeSessionMutate({
              sessionId: currentRun.sessionId,
              body: {
                stepExecutionId: resumeStepExecId,
                input: buildInput(content, config),
                clientMessageId: msgId,
              },
            });
            dispatch({
              type: 'LOCAL_RUN_STATE',
              status: data.status || 'RUNNING',
              requiredInput: data.requiredInput ?? null,
            });
            return;
          } catch (err) {
            // 404 = the resume window closed (step already resumed or
            // expired) — fall through to the queue path below.
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
          }
        }

        // Bug 2: live run but no resume window yet (RUNNING, or PAUSED before
        // the SSE `SessionPaused` lands with `requiredInput`). Queue the
        // message and let the resume-watcher effect below fire it as soon as
        // the contract arrives. If status is still RUNNING, also trigger an
        // interrupt so the orchestrator transitions to PAUSED and emits the
        // contract. Never fall through to `POST /sessions` here — that would
        // dump the user's note into a brand-new session and they'd never see
        // it land.
        if (
          currentRun &&
          (effectiveStatus === 'RUNNING' ||
            effectiveStatus === 'QUEUED' ||
            effectiveStatus === 'WAITING_ON_CHILD' ||
            isPaused)
        ) {
          // Covers the direct-resume 404 fallthrough, where the optimistic
          // bubble was marked 'delivering' above (no-op when already queued).
          dispatch({ type: 'SET_MESSAGE_DELIVERY', id: msgId, deliveryState: 'queued' });
          pendingResumeRef.current = {
            sessionId: currentRun.sessionId,
            content,
            ...(config ? { config } : {}),
            msgId,
          };
          setQueuedMessageId(msgId);
          if (
            effectiveStatus === 'RUNNING' ||
            effectiveStatus === 'QUEUED' ||
            effectiveStatus === 'WAITING_ON_CHILD'
          ) {
            void interruptSessionMutate({ sessionId: currentRun.sessionId }).catch(() => {});
          }
          setOptimisticThinking('Pausing to take your message…');
          return;
        }

        const data = await startSessionMutate({
          target: flowToSessionTarget(selectedFlow),
          input: buildInput(content, config),
          mode: 'chat',
          clientMessageId: msgId,
          ...(draftInvitees && draftInvitees.length > 0 ? { invitees: draftInvitees } : {}),
          ...(simulationRunInput ? { simulationRunInput } : {}),
        });
        // Identity seed only — mutable state goes through the reducer.
        // The LOCAL_RUN_STATE seed survives here: the null → first-runId
        // transition skips use-run-reducer's RESET.
        setCurrentRun({
          sessionId: data.sessionId,
          agentId: selectedFlow.agentId,
          agentVersion: selectedFlow.latestVersion,
          createdAt: new Date().toISOString(),
        });
        dispatch({
          type: 'LOCAL_RUN_STATE',
          status: data.status,
          requiredInput: data.requiredInput ?? null,
        });
      } catch {
        setOptimisticThinking(undefined);
        if (isTerminalStatus) {
          setPastItems((prev) => [
            ...prev,
            {
              kind: 'message',
              message: {
                id: crypto.randomUUID(),
                role: 'system',
                content: 'Failed to start. Please try again.',
                timestamp: new Date().toISOString(),
              },
            },
          ]);
        } else {
          // The SUBMIT_ERROR message explains the failure; the bubble must
          // not keep advertising an in-flight delivery.
          dispatch({ type: 'SET_MESSAGE_DELIVERY', id: msgId, deliveryState: null });
          dispatch({
            type: 'SUBMIT_ERROR',
            error: 'Failed to send. Please try again.',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
          });
        }
      } finally {
        // A queued send stays in-flight: the submit lifecycle hands off to
        // the resume-watcher (or cancelQueuedSend), which owns clearing
        // these. Tearing them down here would blank the "Pausing to take
        // your message…" label and re-open the composer mid-queue (a second
        // submit would silently overwrite the pending message).
        if (pendingResumeRef.current?.msgId !== msgId) {
          setIsSubmitting(false);
          setOptimisticThinking(undefined);
        }
      }
    },
    [
      currentRun,
      selectedFlow,
      dispatch,
      effectiveStatus,
      effectiveRequiredInput,
      blockedOn,
      buildInput,
      isTerminalStatus,
      retryRun,
      startSessionMutate,
      resumeSessionMutate,
      interruptSessionMutate,
      setCurrentRun,
      setPastItems,
      setPastWorkflowRuns,
      setOptimisticThinking,
      draftInvitees,
      simulationRunInput,
    ],
  );

  // Resume-watcher: when a message is queued and `requiredInput` arrives via
  // SSE (the `SessionPaused` event reaches the reducer / session refetch),
  // fire the resume call we deferred from handleSubmit.
  //
  useEffect(() => {
    const queued = pendingResumeRef.current;
    const resumeStepExecId = effectiveRequiredInput?.stepExecutionId;
    if (
      !queued ||
      !resumeStepExecId ||
      effectiveStatus !== 'PAUSED' ||
      blockedOn?.kind === 'workflow_run' ||
      blockedOn?.kind === 'child_session' ||
      blockedOn?.kind === 'needs_oauth_consent' ||
      currentRun?.sessionId !== queued.sessionId
    ) {
      return;
    }
    pendingResumeRef.current = null;
    setQueuedMessageId(null);
    dispatch({ type: 'SET_MESSAGE_DELIVERY', id: queued.msgId, deliveryState: 'delivering' });
    void resumeSessionMutate({
      sessionId: queued.sessionId,
      body: {
        stepExecutionId: resumeStepExecId,
        input: buildInput(queued.content, queued.config),
        clientMessageId: queued.msgId,
      },
    })
      .then((data) => {
        dispatch({
          type: 'LOCAL_RUN_STATE',
          status: data.status || 'RUNNING',
          requiredInput: data.requiredInput ?? null,
        });
      })
      .catch(() => {
        dispatch({ type: 'SET_MESSAGE_DELIVERY', id: queued.msgId, deliveryState: null });
        dispatch({
          type: 'SUBMIT_ERROR',
          error: 'Your message could not be delivered to the paused run. Please try again.',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
      })
      .finally(() => {
        setIsSubmitting(false);
        setOptimisticThinking(undefined);
      });
  }, [
    effectiveStatus,
    effectiveRequiredInput,
    blockedOn,
    currentRun,
    buildInput,
    dispatch,
    resumeSessionMutate,
    setOptimisticThinking,
  ]);

  useEffect(() => {
    const queued = pendingResumeRef.current;
    if (!queued || currentRun?.sessionId === queued.sessionId) return;
    pendingResumeRef.current = null;
    setQueuedMessageId(null);
    setIsSubmitting(false);
    setOptimisticThinking(undefined);
  }, [currentRun, setOptimisticThinking]);

  useEffect(() => {
    const queued = pendingResumeRef.current;
    if (!queued || !isTerminalStatus || currentRun?.sessionId !== queued.sessionId) return;
    pendingResumeRef.current = null;
    setQueuedMessageId(null);
    dispatch({ type: 'REMOVE_MESSAGE', id: queued.msgId });
    dispatch({
      type: 'SUBMIT_ERROR',
      error: 'The run ended before your message could be delivered. Please send it again.',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
    setIsSubmitting(false);
    setOptimisticThinking(undefined);
  }, [isTerminalStatus, currentRun, dispatch, setOptimisticThinking]);

  const cancelQueuedSend = useCallback(() => {
    const queued = pendingResumeRef.current;
    if (!queued) return;
    pendingResumeRef.current = null;
    setQueuedMessageId(null);
    dispatch({ type: 'REMOVE_MESSAGE', id: queued.msgId });
    setOptimisticThinking(undefined);
    setIsSubmitting(false);
  }, [dispatch, setOptimisticThinking]);

  return {
    handleSubmit,
    cancelRun,
    pauseRun,
    retryRun,
    cancelQueuedSend,
    queuedMessageId,
    isSubmitting,
    isInterrupting,
    setIsInterrupting,
  };
}
