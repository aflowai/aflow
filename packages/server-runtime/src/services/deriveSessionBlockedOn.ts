import type { SessionHotState } from '@aflow/redis';
import type { SessionBlockedOn } from '@aflow/schemas';

export function deriveSessionBlockedOn(
  state: Pick<
    SessionHotState,
    'status' | 'waitingOnWorkflowRunId' | 'delegationPauseSource' | 'waitingForChildSessionIds'
  >,
  requiredInputStepExecutionId: string | undefined,
): SessionBlockedOn | null {
  // Status-gated like the other branches: the workflow-wait park sets the
  // session PAUSED, so a non-PAUSED session is never blocked on a workflow run
  // regardless of a lingering marker. This makes correctness robust to a missed
  // clear on any un-park path (e.g. wakeWaiter's evaporated-stepState early
  // return, or a future operator-resume path) — a now-RUNNING/terminal session
  // can't keep deriving a phantom workflow_run block.
  if (state.status === 'PAUSED' && typeof state.waitingOnWorkflowRunId === 'string') {
    return { kind: 'workflow_run', runId: state.waitingOnWorkflowRunId };
  }
  if (
    state.status === 'WAITING_ON_CHILD' ||
    (state.status === 'PAUSED' &&
      state.delegationPauseSource === 'child_running' &&
      Array.isArray(state.waitingForChildSessionIds) &&
      state.waitingForChildSessionIds.length > 0)
  ) {
    return { kind: 'child_session', sessionIds: state.waitingForChildSessionIds ?? [] };
  }
  if (state.status === 'PAUSED' && requiredInputStepExecutionId) {
    return { kind: 'user_input', stepExecutionId: requiredInputStepExecutionId };
  }
  return null;
}
