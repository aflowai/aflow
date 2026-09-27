import { describe, it, expect } from 'vitest';
import type { StepDefinition } from '@aflow/schemas';
import { failureIsAgentFacing } from '../agentFacingFailure.js';

const step = (operation: string, tags: string[] = []): StepDefinition =>
  ({ stepId: 's', stepType: 'ai', operation, tags }) as unknown as StepDefinition;

describe('failureIsAgentFacing', () => {
  it('routes a STATIC graph tool failure to the agent — the regression this closes', () => {
    // `run-coach` is declared in the Helmsman flow with
    // `onFailure: { next: [{ stepId: 'agent' }] }` and carries no `dynamic`
    // tag. The old predicate asked whether the step was agent-SPAWNED, so this
    // answered no: the agent never saw the error and the tool-failure counters
    // never incremented, letting it fail 8,344 times unbounded.
    expect(failureIsAgentFacing(step('ai.agent.turn'))).toBe(true);
  });

  it('routes an agent-spawned dynamic step failure to the agent', () => {
    expect(failureIsAgentFacing(step('ai.agent.turn', ['dynamic', 'parent:agent']))).toBe(true);
  });

  it('does NOT route a failure whose next step is not an agent turn', () => {
    // No agent is waiting on this, so there is nobody to hand the error to.
    expect(failureIsAgentFacing(step('api.http.call'))).toBe(false);
    expect(failureIsAgentFacing(step('workflow.run.start'))).toBe(false);
  });

  it('does NOT route when there is no next step at all', () => {
    expect(failureIsAgentFacing(undefined)).toBe(false);
  });

  it('decides on the edge target alone, never on how the step was dispatched', () => {
    // The whole defect was letting dispatch shape decide a routing question.
    // A step tagged every which way is still judged only by where its failure
    // is routed.
    const shapes = [[], ['dynamic'], ['parent:agent'], ['dynamic', 'parent:agent']];
    for (const tags of shapes) {
      expect(failureIsAgentFacing(step('ai.agent.turn', tags))).toBe(true);
      expect(failureIsAgentFacing(step('compute.sandbox.exec', tags))).toBe(false);
    }
  });
});
