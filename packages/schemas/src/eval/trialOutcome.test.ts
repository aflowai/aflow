import { describe, it, expect } from 'vitest';

import {
  classifyTrialOutcome,
  summariseCaseOutcome,
  isScoredOutcome,
  TRIAL_AGGREGATION_VERSION,
  TrialOutcomeSchema,
  type TrialAxes,
  type TrialOutcomeClass,
} from './trialOutcome.js';

const clean: TrialAxes = {
  executionState: 'completed',
  setupOutcome: 'valid',
  checkOutcome: 'passed',
  qualityOutcome: 'passed',
};

const axes = (over: Partial<TrialAxes>): TrialAxes => ({ ...clean, ...over });
const classOf = (over: Partial<TrialAxes>): TrialOutcomeClass =>
  classifyTrialOutcome(axes(over)).outcomeClass;

describe('classifyTrialOutcome — the ordered rule', () => {
  it('passes a clean trial', () => {
    expect(classOf({})).toBe('behavior_pass');
  });

  it('treats a case with no gating criteria as passing, not unverified', () => {
    expect(classOf({ qualityOutcome: 'not_applicable' })).toBe('behavior_pass');
  });

  it('classes an unusable turn as execution, never as behaviour', () => {
    expect(classOf({ executionState: 'no_terminal_reply' })).toBe('execution_error');
    expect(classOf({ executionState: 'run_failed' })).toBe('execution_error');
  });

  it('counts a conversational pause as reaching the observation boundary', () => {
    // `completed` is the pause state; a subject waiting on a person has not failed.
    expect(classOf({ executionState: 'completed' })).toBe('behavior_pass');
  });

  it('puts invalid setup above everything — nothing is gradeable', () => {
    expect(classOf({ setupOutcome: 'invalid', checkOutcome: 'failed' })).toBe('invalid_case');
    expect(classOf({ setupOutcome: 'invalid', executionState: 'run_failed' })).toBe('invalid_case');
  });

  it('keeps a failing check a failure when a judge abstains', () => {
    expect(
      classOf({
        checkOutcome: 'failed',
        qualityOutcome: 'unverified',
        qualityUnverifiedReason: 'abstained',
      }),
    ).toBe('behavior_fail');
  });

  it('keeps a failing judge a failure when an expectation is undecided', () => {
    // The rule this ordering exists for: missing evidence for one requirement
    // must not retract an independently observed failure of another.
    expect(classOf({ checkOutcome: 'incomplete', qualityOutcome: 'failed' })).toBe('behavior_fail');
  });

  it('reports missing evidence only when nothing definitive failed', () => {
    expect(classOf({ checkOutcome: 'incomplete' })).toBe('incomplete_evidence');
    expect(classOf({ qualityOutcome: 'unverified', qualityUnverifiedReason: 'sampled_out' })).toBe(
      'incomplete_evidence',
    );
  });

  it('stamps the aggregation version on every class', () => {
    const parsed = TrialOutcomeSchema.parse(classifyTrialOutcome(clean));
    expect(parsed.aggregationVersion).toBe(TRIAL_AGGREGATION_VERSION);
  });

  it('scores only the two behavioural classes', () => {
    expect(isScoredOutcome('behavior_pass')).toBe(true);
    expect(isScoredOutcome('behavior_fail')).toBe(true);
    expect(isScoredOutcome('execution_error')).toBe(false);
    expect(isScoredOutcome('invalid_case')).toBe(false);
    expect(isScoredOutcome('incomplete_evidence')).toBe(false);
  });
});

describe('summariseCaseOutcome — pass^k at the configured k', () => {
  it('claims pass^k only when every configured trial was scored', () => {
    const s = summariseCaseOutcome(['behavior_pass', 'behavior_pass', 'behavior_pass'], 3);
    expect(s).toMatchObject({ scored: 3, passed: 3, complete: true, passAllTrials: true });
  });

  it('refuses pass^k for two passes and an execution error', () => {
    // The motivating defect: an infrastructure failure must not read as a
    // three-trial success, and must not read as a behavioural failure either.
    const s = summariseCaseOutcome(['behavior_pass', 'behavior_pass', 'execution_error'], 3);
    expect(s.scored).toBe(2);
    expect(s.passed).toBe(2);
    expect(s.complete).toBe(false);
    expect(s.passAllTrials).toBe(false);
    expect(s.excluded.execution_error).toBe(1);
  });

  it('does not let the rows present redefine k', () => {
    // Two rows arrived for a three-trial case. Deriving k from the rows would
    // make every case complete by construction.
    const s = summariseCaseOutcome(['behavior_pass', 'behavior_pass'], 3);
    expect(s.complete).toBe(false);
  });

  it('counts a real failure as scored, not excluded', () => {
    const s = summariseCaseOutcome(['behavior_pass', 'behavior_fail', 'behavior_pass'], 3);
    expect(s).toMatchObject({ scored: 3, passed: 2, complete: true, passAllTrials: false });
  });

  it('tallies each exclusion against its own class', () => {
    const s = summariseCaseOutcome(['invalid_case', 'execution_error', 'incomplete_evidence'], 3);
    expect(s.excluded).toEqual({
      invalid_case: 1,
      execution_error: 1,
      incomplete_evidence: 1,
    });
    expect(s.scored).toBe(0);
    expect(s.passAllTrials).toBe(false);
  });

  it('never claims pass^k for a case with no trials at all', () => {
    expect(summariseCaseOutcome([], 3).passAllTrials).toBe(false);
    expect(summariseCaseOutcome([], 0).passAllTrials).toBe(false);
  });
});
