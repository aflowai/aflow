import type { SessionHotState } from '@aflow/redis';
import type { RunTrigger } from '@aflow/schemas';

/**
 * The root trigger a session starts with. One its parent queued — a delegate,
 * a workflow task's Runner — already holds its root's; the trigger on the start
 * message is the session's own only when nothing queued it with one.
 */
export function rootTriggerAtStart(
  queued: Pick<SessionHotState, 'rootTrigger'> | null | undefined,
  startTrigger: RunTrigger | undefined,
): RunTrigger | undefined {
  return queued?.rootTrigger ?? startTrigger;
}
