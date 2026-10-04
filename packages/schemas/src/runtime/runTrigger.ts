/**
 * What started a run, and which of those surfaces only a person uses.
 *
 * The trigger names the surface a run came in through and never changes. It
 * does not say whether anyone is present for the run's work now: that is the
 * session's `activatedByPerson`, a fact of what last set it running.
 */
import { z } from 'zod';

export const RunTriggerSchema = z.enum([
  'chat',
  'api',
  'eval',
  'mcp',
  'schedule',
  'voice',
  'webhook',
]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

const ONLY_A_PERSON_USES: Readonly<Record<RunTrigger, boolean>> = {
  chat: true,
  voice: true,
  api: false,
  eval: false,
  // An MCP client is another agent, not a person at this machine's Action Center.
  mcp: false,
  schedule: false,
  webhook: false,
};

/**
 * Whether only a person uses this surface, so the API refuses it from a
 * request not authenticated as an interactive user. Not whether a run is
 * attended: that is the request's credential, whatever surface it names.
 */
export function isPersonTrigger(trigger: RunTrigger | undefined): boolean {
  return trigger !== undefined && ONLY_A_PERSON_USES[trigger];
}
