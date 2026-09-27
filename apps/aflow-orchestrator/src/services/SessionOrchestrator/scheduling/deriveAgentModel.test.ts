import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { deriveAgentModel } from './scheduleStep.js';

function agentWith(model: unknown): AgentDefinition {
  return {
    steps: [
      { stepId: 'other', operation: 'api.http.call', config: { model: 'ignored' } },
      { stepId: 'agent', operation: 'ai.agent.turn', config: model === undefined ? {} : { model } },
    ],
  } as unknown as AgentDefinition;
}

function stateWith(vars: Record<string, unknown>): SessionHotState['runtimeState'] {
  return {
    schemaVersion: 1,
    version: 0,
    updatedAtMs: 0,
    variables: Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, { ref: { kind: 'inline', value: v } }]),
    ),
  } as SessionHotState['runtimeState'];
}

describe('deriveAgentModel', () => {
  it('resolves the state reference the platform agents actually carry', () => {
    // Helmsman's config is `${state.helmsman_model}`, never a literal — the
    // model is the operator's live choice.
    expect(
      deriveAgentModel(
        agentWith('${state.helmsman_model}'),
        stateWith({ helmsman_model: 'glm-pro' }),
      ),
    ).toBe('glm-pro');
  });

  it('never forwards an unresolved expression as if it were a model name', () => {
    // Forwarding `${state.helmsman_model}` verbatim reads as a caller
    // preference downstream, fails to resolve, and hands the choice to
    // whatever default happens to be reachable — which is how a space running
    // GLM ended up generating on an OpenAI model.
    expect(deriveAgentModel(agentWith('${state.helmsman_model}'), stateWith({}))).toBeUndefined();
    expect(deriveAgentModel(agentWith('${state.helmsman_model}'), undefined)).toBeUndefined();
    expect(
      deriveAgentModel(agentWith('pre-${state.x}-post'), stateWith({ x: 'y' })),
    ).toBeUndefined();
  });

  it('passes a literal through', () => {
    expect(deriveAgentModel(agentWith('anthropic-sonnet'), undefined)).toBe('anthropic-sonnet');
  });

  it('reads the agent turn step, not whichever step declares a model first', () => {
    expect(deriveAgentModel(agentWith('glm-pro'), undefined)).toBe('glm-pro');
  });

  it('has no answer when the turn pins nothing', () => {
    expect(
      deriveAgentModel(agentWith(undefined), stateWith({ helmsman_model: 'glm-pro' })),
    ).toBeUndefined();
  });
});
