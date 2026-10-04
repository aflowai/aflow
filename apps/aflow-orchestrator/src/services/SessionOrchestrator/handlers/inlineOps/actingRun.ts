import type { SessionHotState } from '@aflow/redis';

/**
 * Whether a run that another run sets going — by delegating to it, starting it
 * as a workflow task, resuming or answering it, re-parenting it — is attended:
 * exactly as the acting run is now. Read from the acting run's hot state as
 * the command is made, never from the input its agent wrote nor from how it
 * began; a run whose state has aged out reads as nobody's.
 */
export function attendedAsActingRun(
  actingRun: Pick<SessionHotState, 'activatedByPerson'> | null | undefined,
): boolean {
  return actingRun?.activatedByPerson === true;
}
