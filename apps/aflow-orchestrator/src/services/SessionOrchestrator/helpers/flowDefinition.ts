/**
 * Flow definition lookup helpers.
 */
import type { AgentDefinition, StepDefinition, StepId } from '@aflow/schemas';

export function getStepDefinition(agentDef: AgentDefinition, stepId: StepId): StepDefinition {
  const step = agentDef.steps.find((s) => s.stepId === stepId);
  if (!step) throw new Error(`Step ${stepId} not found in flow ${agentDef.flowId}`);
  return step;
}
