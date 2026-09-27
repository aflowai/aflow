import type { SessionHotState } from '@aflow/redis';

export function isDelegationWaitState(runState: SessionHotState): boolean {
  if (runState.status === 'WAITING_ON_CHILD') return true;
  if (
    runState.status === 'PAUSED' &&
    runState.delegationPauseSource === 'child_input' &&
    Boolean(runState.pausedChildSessionId)
  ) {
    return true;
  }
  return false;
}
