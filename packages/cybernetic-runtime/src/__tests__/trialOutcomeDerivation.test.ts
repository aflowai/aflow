import { describe, it, expect } from 'vitest';
import { EvalCaseTrialResultsSchema, type EvalCaseTrialResults } from '@aflow/schemas';

import { computeBatchScorecard } from '../evalBatchPlan.js';
import {
  resultSlotKey,
  deriveTrialOutcome,
  deriveExecutionState,
  type GradableRunRecord,
} from '../evalTrialGrader.js';

const run = (over: Partial<GradableRunRecord> = {}): GradableRunRecord => ({
  status: 'paused',
  pausedReason: 'human_input',
  tasks: [],
  ...over,
});

const results = (over: Partial<EvalCaseTrialResults> = {}): EvalCaseTrialResults =>
  EvalCaseTrialResultsSchema.parse({
    expectationResults: [{ expectationIndex: 0, kind: 'trajectory', passed: true, detail: 'ok' }],
    fractionPassed: 1,
    fixtureTier: 'sealed',
    ...over,
  });

const judged = (criterionId: string, verdict: 'pass' | 'fail') => ({
  status: 'judged' as const,
  criterionId,
  scopeKey: 'case_local',
  judgeVersion: 'v1',
  verdict,
  score: verdict === 'pass' ? 1 : 0,
  rationale: 'because',
});

describe('deriveExecutionState', () => {
  it('prefers the signal execution stamped over any derivation', () => {
    // A paused run that execution knows reached its boundary with no answer.
    // The fallback would read this as `completed` — the stamp is the only
    // thing that knows otherwise.
    const state = deriveExecutionState(
      run({ status: 'paused', executionState: 'no_terminal_reply' }),
    );
    expect(state).toBe('no_terminal_reply');
  });

  it('falls back to the run status when nothing was stamped', () => {
    expect(deriveExecutionState(run({ status: 'failed' }))).toBe('run_failed');
    expect(deriveExecutionState(run({ status: 'cancelled' }))).toBe('run_failed');
    expect(deriveExecutionState(run({ status: 'paused' }))).toBe('completed');
  });
});

describe('deriveTrialOutcome — gating vs advisory', () => {
  it('lets a failing GATING criterion fail the trial', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ rubricResults: [judged('asks-consent', 'fail')] }),
      expectationCount: 1,
      gatingSlots: new Set([
        resultSlotKey({ criterionId: 'asks-consent', scopeKey: 'case_local' }),
      ]),
    });
    expect(outcome.qualityOutcome).toBe('failed');
    expect(outcome.outcomeClass).toBe('behavior_fail');
  });

  it('leaves a failing ADVISORY criterion unable to move the class', () => {
    // The separation the amendment rests on: only slots named as gating decide.
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ rubricResults: [judged('tone', 'fail')] }),
      expectationCount: 1,
      gatingSlots: new Set(),
    });
    expect(outcome.qualityOutcome).toBe('not_applicable');
    expect(outcome.outcomeClass).toBe('behavior_pass');
  });

  it('reports a case with no gating criteria as not_applicable, never unverified', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results(),
      expectationCount: 1,
    });
    expect(outcome.qualityOutcome).toBe('not_applicable');
    expect(outcome.outcomeClass).toBe('behavior_pass');
  });
});

describe('deriveTrialOutcome — why quality went unverified', () => {
  it('names a sampled-out judge', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({
        rubricResults: [{ status: 'not_selected', criterionId: 'c', scopeKey: 'case_local' }],
      }),
      expectationCount: 1,
      gatingSlots: new Set([resultSlotKey({ criterionId: 'c', scopeKey: 'case_local' })]),
    });
    expect(outcome.qualityUnverifiedReason).toBe('sampled_out');
    expect(outcome.outcomeClass).toBe('incomplete_evidence');
  });

  it('names a provider error', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({
        rubricResults: [
          {
            status: 'error',
            criterionId: 'c',
            scopeKey: 'case_local',
            errorCode: 'judge_client_unavailable',
            errorMessage: 'upstream unreachable',
          },
        ],
      }),
      expectationCount: 1,
      gatingSlots: new Set([resultSlotKey({ criterionId: 'c', scopeKey: 'case_local' })]),
    });
    expect(outcome.qualityUnverifiedReason).toBe('provider_error');
  });

  it('separates a configuration fault from a provider outage', () => {
    // A judge refused by the bias rule is not a retryable provider failure.
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({
        rubricResults: [
          {
            status: 'error',
            criterionId: 'c',
            scopeKey: 'case_local',
            errorCode: 'judge_model_equals_subject',
            errorMessage: 'judge model equals subject model',
          },
        ],
      }),
      expectationCount: 1,
      gatingSlots: new Set([resultSlotKey({ criterionId: 'c', scopeKey: 'case_local' })]),
    });
    expect(outcome.qualityUnverifiedReason).toBe('not_run');
  });

  it('names a judge stage that never ran', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ pendingRubrics: ['c'] }),
      expectationCount: 1,
      gatingSlots: new Set([resultSlotKey({ criterionId: 'c', scopeKey: 'case_local' })]),
    });
    expect(outcome.qualityUnverifiedReason).toBe('not_run');
  });
});

describe('deriveTrialOutcome — ordering holds end to end', () => {
  it('keeps a failed gating judge a failure when an expectation is undecided', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ expectationResults: [], rubricResults: [judged('c', 'fail')] }),
      expectationCount: 1,
      gatingSlots: new Set([resultSlotKey({ criterionId: 'c', scopeKey: 'case_local' })]),
    });
    expect(outcome.checkOutcome).toBe('incomplete');
    expect(outcome.outcomeClass).toBe('behavior_fail');
  });

  it('classes a case with no expectations as invalid setup', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ expectationResults: [] }),
      expectationCount: 0,
    });
    expect(outcome.outcomeClass).toBe('invalid_case');
  });

  it('classes a run that produced nothing usable as execution, not behaviour', () => {
    const outcome = deriveTrialOutcome({
      run: run({ executionState: 'no_terminal_reply' }),
      results: results({
        expectationResults: [
          { expectationIndex: 0, kind: 'reply', passed: false, detail: 'no reply text' },
        ],
        fractionPassed: 0,
      }),
      expectationCount: 1,
    });
    // The check failed too, but silence is an execution fact and outranks it.
    expect(outcome.outcomeClass).toBe('execution_error');
  });
});

describe('computeBatchScorecard reads the stored class', () => {
  it('treats a row graded before the class existed as unreadable, not as a pass', () => {
    // Re-folding `verdict` for legacy rows would restore the divergence the
    // stored class removed, so they count as evidence that cannot be read.
    const summary = computeBatchScorecard({
      rows: [
        {
          caseRevisionId: 'case-a',
          trial: 1,
          disposition: 'graded',
          verdict: 'pass',
          outcomeClass: null,
          resultsJson: null,
        },
      ],
      strataByCaseRevision: new Map(),
      trialsPerCase: 1,
      costSpentCents: 0,
    });
    expect(summary.scoredTrials).toBe(0);
    expect(summary.passRate).toBeUndefined();
    expect(summary.excludedTrials.incomplete_evidence).toBe(1);
  });
});

describe('a harness placeholder never reads as the subject speaking', () => {
  it('classes a stamped silent pause as execution, whatever the pause prompt says', () => {
    // dispatchHumanTask writes `Provide input for: <task>` when the subject
    // supplied nothing. That string is non-empty, so without the stamp the
    // reply expectation, the judge's pack and this fold all take it for an
    // answer. The stamp is the only thing that still knows.
    const outcome = deriveTrialOutcome({
      run: run({ executionState: 'no_terminal_reply', pausedPayloadRef: 'inline:abc' }),
      results: results(),
      expectationCount: 1,
    });
    expect(outcome.outcomeClass).toBe('execution_error');
  });

  it('leaves a real reply scored', () => {
    const outcome = deriveTrialOutcome({
      run: run({ executionState: 'completed', pausedPayloadRef: 'inline:abc' }),
      results: results(),
      expectationCount: 1,
    });
    expect(outcome.outcomeClass).toBe('behavior_pass');
  });
});

describe('a judge verdict decides the trial', () => {
  const judgedAs = (verdict: 'pass' | 'fail' | 'unclear') => ({
    status: 'judged' as const,
    criterionId: 'asks-consent',
    scopeKey: 'case_local',
    judgeVersion: 'v1',
    verdict,
    score: verdict === 'pass' ? 1 : 0,
    rationale: 'because',
  });

  it('fails a trial whose quality claim the judge rejected', () => {
    // The whole point: a case can pass every mechanical check and still be a
    // bad answer, and before this the verdict said so and changed nothing.
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ rubricResults: [judgedAs('fail')] }),
      expectationCount: 1,
      gatingSlots: new Set([
        resultSlotKey({ criterionId: 'asks-consent', scopeKey: 'case_local' }),
      ]),
    });
    expect(outcome.outcomeClass).toBe('behavior_fail');
  });

  it('reports an abstention rather than scoring it either way', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ rubricResults: [judgedAs('unclear')] }),
      expectationCount: 1,
      gatingSlots: new Set([
        resultSlotKey({ criterionId: 'asks-consent', scopeKey: 'case_local' }),
      ]),
    });
    expect(outcome.outcomeClass).toBe('incomplete_evidence');
    expect(outcome.qualityUnverifiedReason).toBe('abstained');
  });

  it('passes a trial the judge accepted', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({ rubricResults: [judgedAs('pass')] }),
      expectationCount: 1,
      gatingSlots: new Set([
        resultSlotKey({ criterionId: 'asks-consent', scopeKey: 'case_local' }),
      ]),
    });
    expect(outcome.outcomeClass).toBe('behavior_pass');
  });

  it('keeps a stated failure a failure when a sibling abstains', () => {
    const outcome = deriveTrialOutcome({
      run: run(),
      results: results({
        rubricResults: [judgedAs('fail'), { ...judgedAs('unclear'), criterionId: 'tone' }],
      }),
      expectationCount: 1,
      gatingSlots: new Set([
        resultSlotKey({ criterionId: 'asks-consent', scopeKey: 'case_local' }),
        resultSlotKey({ criterionId: 'tone', scopeKey: 'case_local' }),
      ]),
    });
    expect(outcome.outcomeClass).toBe('behavior_fail');
  });
});
