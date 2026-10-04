/**
 * How a step's stored configuration becomes the policies a turn runs under.
 *
 * Separate from the turn schemas because three call sites need it — turn
 * assembly, decision application, and invalid-decision recovery — and when each
 * spelled the same field reads out for itself, they drifted: `unattended`
 * reached one of the three, so a scheduled assistant was told not to ask and
 * then judged as though it could.
 */
import {
  resolveAgentPolicies,
  type AgentRole,
  type CompletionPolicy,
  type RequestInputPolicy,
} from './agentTurn.js';

/**
 * Triggers that start a run with nobody waiting on its answer, so a turn there
 * must not ask. Not whether a person is present for it — that is the session's
 * `activatedByPerson`: an API caller or an MCP client waits for the answer
 * without being one.
 */
export function startsWithNobodyWaiting(trigger: string | undefined): boolean {
  return trigger === 'schedule' || trigger === 'webhook';
}

/**
 * Resolve policies from a step's loose config.
 *
 * Every site that resolves policies for a running step goes through here — turn
 * assembly, decision application and recovery. They read the same fields, and
 * when the resolution was written out at each of them instead, `unattended`
 * reached one of the three and an unattended assistant was told not to ask and
 * then judged as though it could.
 */
export function resolveAgentPoliciesFromConfig(
  config: Record<string, unknown> | undefined,
  options?: { agentRoleOverride?: AgentRole | undefined; trigger?: string | undefined },
): {
  agentRole: AgentRole;
  requestInputPolicy: RequestInputPolicy;
  completionPolicy: CompletionPolicy;
} {
  const rawRole = options?.agentRoleOverride ?? config?.['agentRole'];
  const rawInput = config?.['requestInputPolicy'];
  const rawCompletion = config?.['completionPolicy'];
  return resolveAgentPolicies({
    agentRole:
      rawRole === 'subagent' ? 'subagent' : rawRole === 'assistant' ? 'assistant' : undefined,
    requestInputPolicy:
      rawInput === 'allowed' || rawInput === 'blocked_only' || rawInput === 'never'
        ? rawInput
        : undefined,
    completionPolicy:
      rawCompletion === 'open_ended' ||
      rawCompletion === 'allowed' ||
      rawCompletion === 'must_complete_or_block'
        ? rawCompletion
        : undefined,
    ...(startsWithNobodyWaiting(options?.trigger) ? { unattended: true } : {}),
  });
}
