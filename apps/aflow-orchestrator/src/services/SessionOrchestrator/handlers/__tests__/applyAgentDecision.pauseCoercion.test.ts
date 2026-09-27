import { describe, it, expect } from 'vitest';
import type { AgentDefinition, AgentTurnDecision, StepDefinition } from '@aflow/schemas';
import { BLOCKED_REASON_AUTO_CONVERT_PREFIX } from '@aflow/schemas';
import { AgentSignalBlockedInputSchema } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { normalizeDecisionForRole } from '../decisionRoleNormalization.js';

const emptyRunState = {} as SessionHotState;

function makeRunnerLikeAgentDef(options: { withSignalBlocked: boolean }): AgentDefinition {
  const execute: StepDefinition = {
    stepId: 'execute',
    stepType: 'agent',
    operation: 'ai.agent.turn',
    name: 'Execute',
    config: {},
    tags: [],
    optional: false,
    onSuccess: {
      next: [
        { stepId: 'submit_output', priority: 50 },
        ...(options.withSignalBlocked ? [{ stepId: 'signal_blocked', priority: 50 }] : []),
      ],
    },
    onFailure: { next: [] },
  } as unknown as StepDefinition;

  const submitOutput: StepDefinition = {
    stepId: 'submit_output',
    stepType: 'agent',
    operation: 'agent.control.submit_output',
    name: 'Submit Output',
    config: {},
    tags: [],
    optional: false,
    onSuccess: { next: [] },
    onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
  } as unknown as StepDefinition;

  const signalBlocked: StepDefinition = {
    stepId: 'signal_blocked',
    stepType: 'agent',
    operation: 'agent.control.signal_blocked',
    name: 'Signal Blocked',
    config: {},
    tags: [],
    optional: false,
    onSuccess: { next: [{ stepId: 'execute', priority: 50 }] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;

  return {
    flowId: 'cybernetic-runner',
    schemaVersion: 1,
    metadata: { name: 'Runner', tags: ['system'] },
    stateVariables: [],
    startStepId: 'execute',
    steps: [execute, submitOutput, ...(options.withSignalBlocked ? [signalBlocked] : [])],
  } as unknown as AgentDefinition;
}

const pauseDecision: AgentTurnDecision = {
  action: 'pause_for_input',
  message: 'Which dataset should I use?',
  reasoning: 'Ambiguous task input',
};

describe('normalizeDecisionForRole', () => {
  it('coerces a forbidden pause into the blocked-signal graph tool under never + open_ended', () => {
    const decision = normalizeDecisionForRole({
      decision: pauseDecision,
      requestInputPolicy: 'never',
      completionPolicy: 'open_ended',
      agentDef: makeRunnerLikeAgentDef({ withSignalBlocked: true }),
      agentStepId: 'execute',
      runState: emptyRunState,
    });
    expect(decision.action).toBe('invoke_step');
    if (decision.action !== 'invoke_step') return;
    expect(decision.toolId).toBe('signal_blocked');
    expect(decision.args).toMatchObject({
      reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}Which dataset should I use?`,
    });
    expect(() => AgentSignalBlockedInputSchema.parse(decision.args)).not.toThrow();
  });

  it('derives the reason cap from the real operation schema for over-long pause messages', () => {
    const decision = normalizeDecisionForRole({
      decision: { action: 'pause_for_input', message: 'x'.repeat(1500) },
      requestInputPolicy: 'never',
      completionPolicy: 'open_ended',
      agentDef: makeRunnerLikeAgentDef({ withSignalBlocked: true }),
      agentStepId: 'execute',
      runState: emptyRunState,
    });
    expect(decision.action).toBe('invoke_step');
    if (decision.action !== 'invoke_step') return;
    expect(() => AgentSignalBlockedInputSchema.parse(decision.args)).not.toThrow();
  });

  it('leaves the pause alone under never + open_ended when the graph has no blocked-signal tool', () => {
    const decision = normalizeDecisionForRole({
      decision: pauseDecision,
      requestInputPolicy: 'never',
      completionPolicy: 'open_ended',
      agentDef: makeRunnerLikeAgentDef({ withSignalBlocked: false }),
      agentStepId: 'execute',
      runState: emptyRunState,
    });
    expect(decision).toBe(pauseDecision);
  });

  it('coerces a forbidden pause to complete when completion is allowed', () => {
    const decision = normalizeDecisionForRole({
      decision: pauseDecision,
      requestInputPolicy: 'never',
      completionPolicy: 'must_complete_or_block',
      agentDef: makeRunnerLikeAgentDef({ withSignalBlocked: true }),
      agentStepId: 'execute',
      runState: emptyRunState,
    });
    expect(decision.action).toBe('complete');
  });

  it('passes legitimate pauses and non-pause decisions through unchanged', () => {
    const agentDef = makeRunnerLikeAgentDef({ withSignalBlocked: true });
    expect(
      normalizeDecisionForRole({
        decision: pauseDecision,
        requestInputPolicy: 'allowed',
        completionPolicy: 'open_ended',
        agentDef,
        agentStepId: 'execute',
        runState: emptyRunState,
      }),
    ).toBe(pauseDecision);

    const invokeDecision: AgentTurnDecision = {
      action: 'invoke_step',
      toolId: 'submit_output',
      args: { output: {} },
    };
    expect(
      normalizeDecisionForRole({
        decision: invokeDecision,
        requestInputPolicy: 'never',
        completionPolicy: 'open_ended',
        agentDef,
        agentStepId: 'execute',
        runState: emptyRunState,
      }),
    ).toBe(invokeDecision);
  });
});
