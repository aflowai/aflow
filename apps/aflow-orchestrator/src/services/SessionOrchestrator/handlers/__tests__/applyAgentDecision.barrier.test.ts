import { describe, it, expect } from 'vitest';
import type { AgentDefinition, AgentTurnDecision, StepDefinition } from '@aflow/schemas';
import {
  isTerminalOnSuccessGraphTool,
  tracksBarrierForAgentReturn,
  validateNoTerminalToolsInParallel,
} from '../applyAgentDecision.js';
import { decisionEmitsSignalBlocked } from '../credentialBlockScope.js';

function makeRunnerLikeAgentDef(): AgentDefinition {
  // Mirrors the Runner graph in `packages/platform-artifacts/src/cyberneticAgents.ts`:
  // execute → submit_output | signal_blocked. submit_output is terminal on success;
  // signal_blocked is terminal on failure but routes back to execute on success.
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
        { stepId: 'signal_blocked', priority: 50 },
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
    steps: [execute, submitOutput, signalBlocked],
  } as unknown as AgentDefinition;
}

describe('isTerminalOnSuccessGraphTool', () => {
  const agentDef = makeRunnerLikeAgentDef();

  it('returns true for submit_output (onSuccess.next is empty)', () => {
    expect(isTerminalOnSuccessGraphTool('submit_output', agentDef)).toBe(true);
  });

  it('returns false for signal_blocked (onSuccess routes back to execute)', () => {
    expect(isTerminalOnSuccessGraphTool('signal_blocked', agentDef)).toBe(false);
  });

  it('returns false for virtual tools (not in agentDef.steps)', () => {
    // Synthetic steps for virtual/discovered tools are constructed with
    // onSuccess→agent. Before the synthetic step is pushed into agentDef
    // they are simply missing from the step list — callers treat that as
    // "non-terminal" because the synthetic shape is guaranteed to route
    // back.
    expect(isTerminalOnSuccessGraphTool('memory.store.put', agentDef)).toBe(false);
  });
});

describe('tracksBarrierForAgentReturn', () => {
  const agentDef = makeRunnerLikeAgentDef();

  it('does NOT track submit_output for the execute agent step', () => {
    // submit_output is the canonical Runner-terminal tool. Counting it in
    // the barrier was the source of the orphaned-barrier warnings.
    expect(tracksBarrierForAgentReturn('submit_output', agentDef, 'execute')).toBe(false);
  });

  it('tracks signal_blocked because it routes back to execute on success', () => {
    expect(tracksBarrierForAgentReturn('signal_blocked', agentDef, 'execute')).toBe(true);
  });

  it('tracks virtual tools (always constructed to route back to agent)', () => {
    expect(tracksBarrierForAgentReturn('memory.store.put', agentDef, 'execute')).toBe(true);
  });
});

describe('validateNoTerminalToolsInParallel', () => {
  const agentDef = makeRunnerLikeAgentDef();

  it('rejects invoke_steps that contains submit_output', () => {
    const err = validateNoTerminalToolsInParallel(
      [{ toolId: 'memory.store.put' }, { toolId: 'submit_output' }],
      agentDef,
    );
    expect(err).not.toBeNull();
    expect(err).toContain('submit_output');
    expect(err).toContain('invoke_step');
  });

  it('accepts a parallel set of normal/virtual tools', () => {
    const err = validateNoTerminalToolsInParallel(
      [{ toolId: 'memory.store.put' }, { toolId: 'signal_blocked' }],
      agentDef,
    );
    expect(err).toBeNull();
  });

  it('accepts an empty list', () => {
    const err = validateNoTerminalToolsInParallel([], agentDef);
    expect(err).toBeNull();
  });
});

describe('decisionEmitsSignalBlocked — Plan 182 Task 1 (review)', () => {
  const agentDef = makeRunnerLikeAgentDef();

  const decision = (d: Record<string, unknown>): AgentTurnDecision =>
    d as unknown as AgentTurnDecision;

  it('true for invoke_step calling signal_blocked', () => {
    expect(
      decisionEmitsSignalBlocked(
        decision({ action: 'invoke_step', toolId: 'signal_blocked', args: { reason: 'no creds' } }),
        agentDef,
      ),
    ).toBe(true);
  });

  it('false for invoke_step calling a non-signal_blocked tool', () => {
    expect(
      decisionEmitsSignalBlocked(
        decision({ action: 'invoke_step', toolId: 'submit_output', args: {} }),
        agentDef,
      ),
    ).toBe(false);
  });

  it('true for invoke_steps containing signal_blocked among siblings', () => {
    expect(
      decisionEmitsSignalBlocked(
        decision({
          action: 'invoke_steps',
          calls: [
            { toolId: 'memory.store.put', args: {} },
            { toolId: 'signal_blocked', args: {} },
          ],
        }),
        agentDef,
      ),
    ).toBe(true);
  });

  it('false for invoke_steps with no signal_blocked', () => {
    expect(
      decisionEmitsSignalBlocked(
        decision({ action: 'invoke_steps', calls: [{ toolId: 'memory.store.put', args: {} }] }),
        agentDef,
      ),
    ).toBe(false);
  });

  it('false for complete / pause_for_input (no tool calls carried)', () => {
    expect(decisionEmitsSignalBlocked(decision({ action: 'complete' }), agentDef)).toBe(false);
    expect(decisionEmitsSignalBlocked(decision({ action: 'pause_for_input' }), agentDef)).toBe(
      false,
    );
  });

  it('false when the toolId is unknown to the agent graph', () => {
    expect(
      decisionEmitsSignalBlocked(
        decision({ action: 'invoke_step', toolId: 'not_a_real_step', args: {} }),
        agentDef,
      ),
    ).toBe(false);
  });
});
