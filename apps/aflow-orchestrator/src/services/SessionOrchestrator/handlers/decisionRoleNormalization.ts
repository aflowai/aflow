import type {
  AgentDefinition,
  AgentTurnDecision,
  CompletionPolicy,
  RequestInputPolicy,
} from '@aflow/schemas';
import { normalizeDisallowedPauseDecision } from '@aflow/schemas';
import { parseRunAccessGrant, type SessionHotState } from '@aflow/redis';
import { buildAvailableTools } from '../helpers/agentTurn.js';
import { applyToolAccess, type ToolAccessContext } from '../helpers/toolAccess.js';

function toolAccessFromRunState(runState: SessionHotState): ToolAccessContext {
  return { grant: runState.grantJson ? parseRunAccessGrant(runState.grantJson) : null };
}

/**
 * Orchestrator-side mirror of the executor's pause coercion — a forbidden
 * pause can reach here without passing the executor's gate (policies are
 * re-derived from step config and may be tighter; non-AI executors emit
 * decisions too). The graph-tool surface locates the blocked-signal escape
 * and is only built when a pause needs it; it passes through the same grant
 * filter as the offered surface so the escape can never materialize a tool
 * the run was not handed.
 */
export function normalizeDecisionForRole(params: {
  decision: AgentTurnDecision;
  requestInputPolicy: RequestInputPolicy;
  completionPolicy: CompletionPolicy;
  agentDef: AgentDefinition;
  agentStepId: string;
  runState: SessionHotState;
}): AgentTurnDecision {
  return normalizeDisallowedPauseDecision({
    requestInputPolicy: params.requestInputPolicy,
    allowComplete: params.completionPolicy !== 'open_ended',
    decision: params.decision,
    availableTools:
      params.decision.action === 'pause_for_input'
        ? applyToolAccess(
            buildAvailableTools(params.agentDef, params.agentStepId),
            toolAccessFromRunState(params.runState),
          )
        : undefined,
  });
}
