import type { Redis } from 'ioredis';
import { updateSessionState } from '@aflow/redis';
import type { SessionHotState } from '@aflow/redis';
import type { AgentDefinition, AgentTurnDecision, SessionId, TenantId } from '@aflow/schemas';
import { AGENT_SIGNAL_BLOCKED_OPERATION_ID } from '@aflow/schemas';

/**
 * Does this finalized agent decision schedule a call to the
 * `agent.control.signal_blocked` graph tool? Only `invoke_step` /
 * `invoke_steps` decisions carry tool calls; every other action
 * (complete, pause_for_input, …) returns false.
 *
 * Exported for unit testing.
 */
export function decisionEmitsSignalBlocked(
  decision: AgentTurnDecision,
  agentDef: AgentDefinition,
): boolean {
  const isSignalBlockedTool = (toolId: string): boolean =>
    agentDef.steps.some(
      (s) => s.stepId === toolId && s.operation === AGENT_SIGNAL_BLOCKED_OPERATION_ID,
    );
  if (decision.action === 'invoke_step') return isSignalBlockedTool(decision.toolId);
  if (decision.action === 'invoke_steps')
    return decision.calls.some((c) => isSignalBlockedTool(c.toolId));
  return false;
}

/**
 * Clear a stale `pendingCredentialBlock` marker at the agent-turn boundary.
 *
 * No-op when no marker is set, or when THIS turn escalates via
 * `signal_blocked` (the inline handler consumes it). Only call on the normal
 * decision path — guardrail retry/escalate intentionally preserves the marker
 * (the turn either re-runs or pauses for human review).
 */
export async function clearStaleCredentialBlock(
  redis: Redis,
  ids: { tenantId: string; sessionId: string },
  runHotState: SessionHotState,
  decision: AgentTurnDecision,
  agentDef: AgentDefinition,
): Promise<void> {
  if (!runHotState.pendingCredentialBlock) return;
  if (decisionEmitsSignalBlocked(decision, agentDef)) return;
  await updateSessionState(redis, ids.tenantId as TenantId, ids.sessionId as SessionId, {
    pendingCredentialBlock: undefined,
  });
}
