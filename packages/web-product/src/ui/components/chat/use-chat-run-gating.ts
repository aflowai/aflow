'use client';

import { useMemo } from 'react';
import type { RunViewState } from '@aflow/run-view';

export interface ChatRunGatingInput {
  reducerStatus: RunViewState['status'];
  reducerRequiredInput: RunViewState['requiredInput'];
  reducerBlockedOn: RunViewState['blockedOn'];
  /**
   * True while the snapshot fetch is in flight (use-run-reducer's `gated`
   * mode). Status is unknown in this window — the composer stays disabled
   * so a stale "enabled" state never flashes before the snapshot lands.
   */
  isHydrating: boolean;
  /** Identity presence — a session is seeded (currentRun != null). */
  hasSession: boolean;
  selectedFlow: { agentId: string } | null;
}

/**
 * Pure gating decision, extracted from the hook so it's unit-testable without
 * a React renderer (the web vitest env is node-only). `useChatRunGating` is a
 * thin `useMemo` wrapper over this.
 */
export function deriveChatRunGating({
  reducerStatus,
  reducerRequiredInput,
  reducerBlockedOn,
  isHydrating,
  hasSession,
  selectedFlow,
}: ChatRunGatingInput) {
  const effectiveStatus = reducerStatus;
  const effectiveRequiredInput = reducerRequiredInput;

  const isDelegatingToWorkflow =
    effectiveStatus === 'PAUSED' &&
    reducerBlockedOn != null &&
    (reducerBlockedOn.kind === 'workflow_run' || reducerBlockedOn.kind === 'child_session');

  const hasLiveWorkflowSurface = effectiveStatus === 'WAITING_ON_CHILD' || isDelegatingToWorkflow;

  const isTerminalStatus =
    effectiveStatus != null &&
    ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED'].includes(effectiveStatus);

  const canSend =
    selectedFlow != null &&
    !isHydrating &&
    (!hasSession || (effectiveStatus === 'PAUSED' && !isDelegatingToWorkflow) || isTerminalStatus);

  const isRunActive =
    hasSession &&
    (effectiveStatus === 'QUEUED' ||
      effectiveStatus === 'RUNNING' ||
      effectiveStatus === 'PAUSED' ||
      effectiveStatus === 'WAITING_ON_CHILD');

  return {
    effectiveStatus,
    effectiveRequiredInput,
    hasLiveWorkflowSurface,
    isDelegatingToWorkflow,
    isTerminalStatus,
    canSend,
    isRunActive,
    isFailed: effectiveStatus === 'FAILED',
  };
}

export function useChatRunGating(input: ChatRunGatingInput) {
  const {
    reducerStatus,
    reducerRequiredInput,
    reducerBlockedOn,
    isHydrating,
    hasSession,
    selectedFlow,
  } = input;
  return useMemo(
    () =>
      deriveChatRunGating({
        reducerStatus,
        reducerRequiredInput,
        reducerBlockedOn,
        isHydrating,
        hasSession,
        selectedFlow,
      }),
    [reducerStatus, reducerRequiredInput, reducerBlockedOn, isHydrating, hasSession, selectedFlow],
  );
}
