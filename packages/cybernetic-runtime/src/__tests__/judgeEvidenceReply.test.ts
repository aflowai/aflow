import { describe, expect, it } from 'vitest';
import type { GoldenCase } from '@aflow/schemas';
import { buildCaseRubricJudgeEvidence } from '../evalJudgeEvidence.js';
import { collectGradingPayloadRefs, type GradableRunRecord } from '../evalTrialGrader.js';
import { buildJudgeUserMessage } from '../prompts/judge.js';

/**
 * A conversational subject's answer lives in the pause contract, not in a task
 * output. A judge given only task outputs reads raw tool JSON, finds no prose,
 * and scores the criterion against an answer it was never shown — the verdicts
 * that provoked this file said "the task is paused, so there is no
 * customer-facing answer to evaluate" about runs that had answered in full.
 */
describe('rubric judge evidence carries the paused reply', () => {
  const PAUSE_REF = 'inline:pause';

  const run: GradableRunRecord = {
    status: 'paused',
    pausedReason: 'user_input_required',
    pausedPayloadRef: PAUSE_REF,
    tasks: [
      {
        taskId: 'answer-the-customer',
        status: 'paused',
        operationId: 'ai.agent.turn',
        outputRef: null,
        summary: 'asked the customer a question',
      },
    ],
  };

  const payloads = new Map<string, unknown>([
    [PAUSE_REF, { prompt: 'The card was charged 45 SAR, but it has not reached your plan yet.' }],
  ]);

  const goldenCase = { provenance: { source: 'curated' } } as unknown as GoldenCase;

  it('the reply reaches the evidence pack', async () => {
    const evidence = await buildCaseRubricJudgeEvidence({
      goldenCase,
      runRecord: run,
      payloads,
      retrievePayload: () => Promise.reject(new Error('no IO expected')),
    });
    expect(evidence.reply).toBe(
      'The card was charged 45 SAR, but it has not reached your plan yet.',
    );
  });

  it('the reply is rendered into the judge prompt', async () => {
    const evidence = await buildCaseRubricJudgeEvidence({
      goldenCase,
      runRecord: run,
      payloads,
      retrievePayload: () => Promise.reject(new Error('no IO expected')),
    });
    const message = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'unconfirmed allocation is conveyed',
        rubric: [{ criterion: 'says it has not landed', description: 'plainly', scale: 'binary' }],
      },
      ...evidence,
    });
    expect(message).toContain('has not reached your plan yet');
  });

  it('the pause contract is prefetched for a case whose only assertion is a rubric', () => {
    // The reply used to ride the prefetch of a `reply` expectation. A case that
    // asserts through a judge alone would then be judged on an empty pack.
    expect(collectGradingPayloadRefs([], run)).toContain(PAUSE_REF);
  });
});

describe('a paused turn does not tell the judge nothing was produced', () => {
  const PAUSE_REF = 'inline:pause';
  const OUTPUT_REF = 'inline:output';

  it('drops the pause contract from task outputs once the reply carries its prose', async () => {
    // The contract's missingVariables/resumeContract read as machinery
    // reporting an absent answer; a judge shown both believes the machinery.
    const run = {
      status: 'paused',
      pausedReason: 'user_input_required',
      pausedPayloadRef: PAUSE_REF,
      tasks: [
        {
          taskId: 'answer-the-customer',
          status: 'paused',
          operationId: 'ai.agent.turn',
          outputRef: OUTPUT_REF,
          summary: 'asked the customer a question',
        },
      ],
    } as unknown as GradableRunRecord;

    const payloads = new Map<string, unknown>([
      [PAUSE_REF, { prompt: 'Your IKEA order was not approved when it was assessed.' }],
      [
        OUTPUT_REF,
        {
          reason: 'input_required',
          missingVariables: [{ variableId: 'ai.agent.chatInput.converse', name: 'Message' }],
          resumeContract: { reason: 'input_required' },
          prompt: 'Your IKEA order was not approved when it was assessed.',
        },
      ],
    ]);

    const evidence = await buildCaseRubricJudgeEvidence({
      goldenCase: { provenance: { source: 'curated' } } as unknown as GoldenCase,
      runRecord: run,
      payloads,
      retrievePayload: () => Promise.reject(new Error('no IO expected')),
    });

    expect(evidence.reply).toContain('not approved');
    expect(evidence.taskOutputs ?? []).toHaveLength(0);
  });
});

describe('the judge is shown what the tools told the agent', () => {
  const PAUSE_REF = 'inline:pause';
  const CALL_REF = 'inline:call';

  const run = {
    status: 'paused',
    pausedReason: 'user_input_required',
    pausedPayloadRef: PAUSE_REF,
    tasks: [],
    simulationCalls: [
      {
        simulationId: 'cs-desk',
        endpointId: 'payments_search',
        responseStatus: 200,
        responseRef: CALL_REF,
        deltaRef: null,
        ordinal: 0,
      },
    ],
  } as unknown as GradableRunRecord;

  const payloads = new Map<string, unknown>([
    [PAUSE_REF, { prompt: 'A refund RFD-3101 is due by 12 September.' }],
    [CALL_REF, { remediation: { reference: 'RFD-3101', expected_by: '2026-09-12' } }],
  ]);

  it('carries the tool bodies the reply was built from', async () => {
    // A judge given only the reply reads a correct reference it cannot
    // corroborate as an invented one, and fails a right answer.
    const evidence = await buildCaseRubricJudgeEvidence({
      goldenCase: { provenance: { source: 'curated' } } as unknown as GoldenCase,
      runRecord: run,
      payloads,
      retrievePayload: () => Promise.reject(new Error('no IO expected')),
    });
    expect(evidence.toolResults).toHaveLength(1);
    expect(evidence.toolResults?.[0]?.endpointId).toBe('payments_search');
    expect(evidence.toolResults?.[0]?.body).toContain('RFD-3101');
  });

  it('prefetches every simulated response, not only the ones an expectation names', () => {
    expect(collectGradingPayloadRefs([], run)).toContain(CALL_REF);
  });
});
