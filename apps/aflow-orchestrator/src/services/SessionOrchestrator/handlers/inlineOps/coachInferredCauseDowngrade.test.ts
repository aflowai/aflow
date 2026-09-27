import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LearnerProposeWorkflowChangeInput } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';

const mocks = vi.hoisted(() => ({
  persistObservation: vi.fn(),
  emitStepSuccess: vi.fn(),
  emitStepError: vi.fn(),
  requireSpaceId: vi.fn(),
  appendEntityEvent: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  persistObservation: mocks.persistObservation,
}));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    appendEntityEvent: (...args: unknown[]) => mocks.appendEntityEvent(...args),
  };
});

vi.mock('./helpers.js', () => ({
  emitStepSuccess: mocks.emitStepSuccess,
  emitStepError: mocks.emitStepError,
}));

vi.mock('./spaceScope.js', () => ({
  requireSpaceId: mocks.requireSpaceId,
}));

import { routeInferredCauseToObservation } from './coachInferredCauseDowngrade.js';

const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-000000000099';
const RUN_ID = '00000000-0000-0000-0000-000000000001';
const OBS_ID = '00000000-0000-0000-0000-0000000000ab';

const ARGS = {
  context: {
    tenantId: TENANT,
    runId: SESSION,
    stateVariables: { run_id: RUN_ID },
  },
  stepExecutionId: 'step-1',
  redis: {},
} as unknown as InlineHandlerArgs;

const EXPLANATION =
  'Recorded as an observation because the cause is inferred without a confirmation step.';

function input(
  overrides: Partial<LearnerProposeWorkflowChangeInput> = {},
): LearnerProposeWorkflowChangeInput {
  return {
    targetSlug: 'kaggle-housing',
    ops: [{ op: 'update_task_goal', taskId: 'train', newGoal: 'Train with bounded depth.' }],
    rationale: 'Train task timed out; reduce estimator count.',
    confidence: 'medium',
    diagnosis: { issueCategory: 'procedure' },
    evidence: {
      sourceSessionIds: [RUN_ID],
      digestCitations: [{ runId: RUN_ID, taskId: 'train' }],
      warrant: {
        claim: 'Train task needs bounded depth',
        evidenceSummary: 'The run slowed; likely the estimator count.',
        warrant: 'Bounded depth caps cost.',
        causeStatus: 'inferred',
        expectedEffect: 'Next run completes in budget.',
      },
    },
    ...overrides,
  } as LearnerProposeWorkflowChangeInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSpaceId.mockReturnValue(SPACE);
  mocks.persistObservation.mockResolvedValue({
    observationId: OBS_ID,
    observationRef: `/coach/observations/${OBS_ID}.json`,
  });
});

describe('routeInferredCauseToObservation (Plan 237 #1)', () => {
  it('records an observation carrying the explanation as detail', async () => {
    await routeInferredCauseToObservation(ARGS, input(), EXPLANATION, 0);

    expect(mocks.persistObservation).toHaveBeenCalledTimes(1);
    const params = mocks.persistObservation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      coachSessionId: SESSION,
      workflowSlug: 'kaggle-housing',
      runId: RUN_ID,
      reason: 'other',
      detail: EXPLANATION,
    });
    expect(String(params['summary'])).toContain('Inferred cause, unconfirmed');
    expect(mocks.emitStepError).not.toHaveBeenCalled();
  });

  it('returns a visible, explanatory result — downgraded from workflow_change to observation_only', async () => {
    await routeInferredCauseToObservation(ARGS, input(), EXPLANATION, 0);

    expect(mocks.emitStepSuccess).toHaveBeenCalledWith(
      ARGS,
      {
        downgradedFrom: 'workflow_change',
        recordedAs: 'observation_only',
        observationId: OBS_ID,
        observationRef: `/coach/observations/${OBS_ID}.json`,
        reason: EXPLANATION,
        confirmation: null,
      },
      0,
    );
  });

  it('surfaces the operator-supplied confirmation ask when present on the withheld proposal', async () => {
    const withConfirmation = input({
      evidence: {
        ...input().evidence,
        warrant: {
          ...input().evidence.warrant!,
          confirmation: 'Re-run with the reverted config to confirm the regression.',
        },
      },
    });
    await routeInferredCauseToObservation(ARGS, withConfirmation, EXPLANATION, 0);

    const result = mocks.emitStepSuccess.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(result['confirmation']).toBe(
      'Re-run with the reverted config to confirm the regression.',
    );
  });

  it('emits a traceable suppressed event naming the inferred-cause reason', async () => {
    await routeInferredCauseToObservation(ARGS, input(), EXPLANATION, 0);

    expect(mocks.appendEntityEvent).toHaveBeenCalledTimes(1);
    const event = (mocks.appendEntityEvent.mock.calls[0]?.[1] as { event: Record<string, unknown> })
      .event;
    expect(event['eventType']).toBe('entity.coach.suppressed');
    expect(event['payload']).toMatchObject({
      reason: 'inferred_cause_unconfirmed',
      observationId: OBS_ID,
    });
  });

  it('surfaces a persistence failure instead of silently dropping the downgrade', async () => {
    mocks.persistObservation.mockRejectedValue(new Error('doc write failed'));
    await routeInferredCauseToObservation(ARGS, input(), EXPLANATION, 0);

    expect(mocks.emitStepError).toHaveBeenCalledWith(
      ARGS,
      'OBSERVATION_RECORD_FAILED',
      'doc write failed',
      0,
      'internal',
    );
    expect(mocks.emitStepSuccess).not.toHaveBeenCalled();
  });
});
