/**
 * What started a run, and whether that was a person.
 *
 * A child run — a delegate, a workflow task — is started by its parent, so
 * what it carries is its root's trigger: a Runner a conversation delegated to
 * answers as the conversation does.
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

const STARTED_BY_A_PERSON: Readonly<Record<RunTrigger, boolean>> = {
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
 * Whether a person started the root of this run. A run whose root trigger is
 * unknown was not, as far as anything downstream can tell.
 */
export function isAttendedRun(rootTrigger: RunTrigger | undefined): boolean {
  return rootTrigger !== undefined && STARTED_BY_A_PERSON[rootTrigger];
}
