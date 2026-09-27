import { describe, expect, it } from 'vitest';
import { classifyTrialOutcome, verdictForOutcomeClass } from '../trialOutcome.js';

/**
 * A live batch stored `verdict: pass` on trials an `outcome_class` of
 * `behavior_fail` said the judge had failed — two fields answering one question
 * differently, where a reader's choice of field decided whether a suite looked
 * healthy. The judge had caught the desk inventing a recheck time no tool
 * returned, which is exactly the kind of failure only a judge can see.
 */
const base = {
  executionState: 'completed',
  setupOutcome: 'valid',
} as const;

describe('one verdict, folded from every axis', () => {
  it('fails a trial the judge failed, whatever the deterministic checks said', () => {
    const outcome = classifyTrialOutcome({
      ...base,
      checkOutcome: 'passed',
      qualityOutcome: 'failed',
    });
    expect(outcome.outcomeClass).toBe('behavior_fail');
    expect(verdictForOutcomeClass(outcome.outcomeClass)).toBe('fail');
  });

  it('fails a trial the checks failed, whatever the judge said', () => {
    const outcome = classifyTrialOutcome({
      ...base,
      checkOutcome: 'failed',
      qualityOutcome: 'passed',
    });
    expect(verdictForOutcomeClass(outcome.outcomeClass)).toBe('fail');
  });

  it('passes a rubric-only case the judge passed, with no deterministic check at all', () => {
    const outcome = classifyTrialOutcome({
      ...base,
      checkOutcome: 'not_applicable',
      qualityOutcome: 'passed',
    });
    expect(outcome.outcomeClass).toBe('behavior_pass');
    expect(verdictForOutcomeClass(outcome.outcomeClass)).toBe('pass');
  });

  it('fails a rubric-only case the judge failed', () => {
    const outcome = classifyTrialOutcome({
      ...base,
      checkOutcome: 'not_applicable',
      qualityOutcome: 'failed',
    });
    expect(verdictForOutcomeClass(outcome.outcomeClass)).toBe('fail');
  });

  it('calls a trial with no usable claim an error, not a pass', () => {
    const outcome = classifyTrialOutcome({
      ...base,
      checkOutcome: 'passed',
      qualityOutcome: 'unverified',
      qualityUnverifiedReason: 'abstained',
    });
    expect(outcome.outcomeClass).toBe('incomplete_evidence');
    expect(verdictForOutcomeClass(outcome.outcomeClass)).toBe('error');
  });

  it('passes only when both axes are satisfied or absent', () => {
    expect(
      verdictForOutcomeClass(
        classifyTrialOutcome({ ...base, checkOutcome: 'passed', qualityOutcome: 'not_applicable' })
          .outcomeClass,
      ),
    ).toBe('pass');
  });
});
