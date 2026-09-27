import { describe, it, expect } from 'vitest';
import {
  AgentSubmitOutputInputSchema,
  buildAgentCondition,
  computeAgentDisposition,
  deriveAgentComplexity,
  deriveAgentProgress,
  type AgentConditionDerivationPolicy,
} from '../index.js';

const POLICY: AgentConditionDerivationPolicy = {
  involvedStepFloor: 8,
  sprawlingStepFloor: 25,
  stalledFailureRatio: 0.5,
};

describe('computeAgentDisposition (trace-derived only)', () => {
  it('stalled on routine complexity → struggling', () => {
    expect(computeAgentDisposition({ progress: 'stalled', complexity: 'routine' })).toBe(
      'struggling',
    );
  });

  it('stalled on involved/sprawling complexity → steady (expected effort)', () => {
    expect(computeAgentDisposition({ progress: 'stalled', complexity: 'involved' })).toBe('steady');
    expect(computeAgentDisposition({ progress: 'stalled', complexity: 'sprawling' })).toBe(
      'steady',
    );
  });

  it('advancing on any complexity → steady', () => {
    expect(computeAgentDisposition({ progress: 'advancing', complexity: 'routine' })).toBe(
      'steady',
    );
    expect(computeAgentDisposition({ progress: 'advancing', complexity: 'sprawling' })).toBe(
      'steady',
    );
  });
});

describe('trace-derived axes (183d §4.2)', () => {
  it('buckets complexity by the named step floors', () => {
    expect(deriveAgentComplexity({ stepCount: 3, failedStepCount: 0 }, POLICY)).toBe('routine');
    expect(deriveAgentComplexity({ stepCount: 8, failedStepCount: 0 }, POLICY)).toBe('involved');
    expect(deriveAgentComplexity({ stepCount: 25, failedStepCount: 0 }, POLICY)).toBe('sprawling');
  });

  it('derives stalled progress from the failed-step ratio knob', () => {
    expect(deriveAgentProgress({ stepCount: 4, failedStepCount: 1 }, POLICY)).toBe('advancing');
    expect(deriveAgentProgress({ stepCount: 4, failedStepCount: 2 }, POLICY)).toBe('stalled');
    expect(deriveAgentProgress({ stepCount: 0, failedStepCount: 0 }, POLICY)).toBe('advancing');
  });

  it('buildAgentCondition assembles axes + computed disposition + trace provenance', () => {
    const condition = buildAgentCondition({ stepCount: 3, failedStepCount: 0 }, POLICY);
    expect(condition).toEqual({
      progress: 'advancing',
      complexity: 'routine',
      disposition: 'steady',
      trace: { stepCount: 3, failedStepCount: 0 },
    });
  });

  it('buildAgentCondition produces struggling when stalled on routine', () => {
    const condition = buildAgentCondition({ stepCount: 4, failedStepCount: 2 }, POLICY);
    expect(condition.disposition).toBe('struggling');
    expect(condition.progress).toBe('stalled');
    expect(condition.complexity).toBe('routine');
  });
});

describe('submit_output contract', () => {
  it('accepts a submit_output carrying nothing, since the draft is the output', () => {
    expect(AgentSubmitOutputInputSchema.safeParse({}).success).toBe(true);
    expect(AgentSubmitOutputInputSchema.safeParse({ summary: 'Done.' }).success).toBe(true);
  });

  it('refuses a literal result rather than stripping it', () => {
    // A non-strict object accepted `{ result }` and dropped it, so a caller
    // that believed it submitted a literal got an empty input — and, if a draft
    // happened to exist, a success describing something else entirely.
    const parsed = AgentSubmitOutputInputSchema.safeParse({ result: { ok: true } });
    expect(parsed.success).toBe(false);
    expect(AgentSubmitOutputInputSchema.safeParse({ result: {}, summary: 'Done.' }).success).toBe(
      false,
    );
  });
});
