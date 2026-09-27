import { describe, it, expect } from 'vitest';
import {
  buildSuggestedActionForFailedTask,
  RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS,
  type WorkflowDefinitionResolution,
} from '../workflowRunDetail.js';
import type { WorkflowTaskRow } from '../ledger.js';
import type { WorkflowTask } from '@aflow/schemas';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const SLUG = 'propose-and-execute-trade';
const FAILED_AT = new Date('2026-05-14T10:46:00.000Z');

function failedRow(overrides: Partial<WorkflowTaskRow> = {}): WorkflowTaskRow {
  return {
    id: 'row-1',
    runId: RUN_ID,
    taskId: 'submit-order',
    status: 'failed',
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: 'Alpaca returned HTTP 400',
    outputRef: null,
    reflectionJson: null,
    operationId: 'api.http.call',
    errorCode: 'EGRESS_HTTP_400',
    errorClassification: 'external_dependency',
    errorRetryable: false,
    failedAt: FAILED_AT,
    priorFailures: [],
    ...overrides,
  };
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 'submit-order',
    name: 'Submit Order',
    goal: 'Place the trade with the broker.',
    type: 'agent',
    agent: 'cybernetic-runner',
    ...overrides,
  } as WorkflowTask;
}

function resolved(taskDefs: WorkflowTask[]): WorkflowDefinitionResolution {
  const tasksById = new Map<string, WorkflowTask>();
  for (const t of taskDefs) tasksById.set(t.taskId, t);
  return { kind: 'resolved', tasksById };
}
const UNRESOLVABLE: WorkflowDefinitionResolution = { kind: 'unresolvable' };

describe('buildSuggestedActionForFailedTask — Plan 149 §3.2', () => {
  describe('preconditions for retryable variants', () => {
    it('safe retryability → no side-effects warning; transient error → "transient" framing', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ errorRetryable: true }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.resume');
      if (action?.op !== 'workflow.run.resume') throw new Error('unreachable');
      expect(action.preconditions).toBe('No external state needs fixing; the error was transient.');
      expect(action.preconditions).not.toContain('Side effects');
      expect(action.upstreamStatePreserved).toBe(true);
    });

    it('safe retryability → no side-effects warning; non-transient error → "fix the binding" framing', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ errorRetryable: false, errorCode: 'EGRESS_HTTP_400' }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.preconditions).toContain('Resolve EGRESS_HTTP_400');
      expect(action.preconditions).not.toContain('Side effects');
    });

    it('unsafe retryability → prepends side-effects warning to the framing', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ errorRetryable: false, errorCode: 'EGRESS_HTTP_400' }),
        resolved([task({ retryability: 'unsafe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.preconditions).toMatch(/^Side effects may have occurred/);
      expect(action.preconditions).toContain('Resolve EGRESS_HTTP_400');
    });

    it('unknown retryability (default) → prepends side-effects warning (conservative)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ errorRetryable: false, errorCode: 'EGRESS_HTTP_400' }),
        // retryability omitted → mapper defaults to 'unknown'.
        resolved([task({ maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.preconditions).toMatch(/^Side effects may have occurred/);
    });

    it('no errorCode → generic framing (no SCREAMING_SNAKE_CASE code mentioned)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ errorRetryable: false, errorCode: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.preconditions).toContain('Resolve the failure cause');
      expect(action.preconditions).not.toMatch(/[A-Z_]+:/);
    });
  });

  describe('CAS args on the retry suggestion', () => {
    it('embeds (taskId, failedAt, attempt) and omits pauseVersion', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 2 }),
        resolved([task({ retryability: 'safe', maxAttempts: 5 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.args.runId).toBe(RUN_ID);
      expect(action.args.pauseVersion).toBeUndefined();
      expect(action.args.resolution.mode).toBe('retry_failed_task');
      if (action.args.resolution.mode !== 'retry_failed_task') throw new Error('unreachable');
      expect(action.args.resolution.taskId).toBe('submit-order');
      expect(action.args.resolution.failedAt).toBe(FAILED_AT.toISOString());
      expect(action.args.resolution.attempt).toBe(2);
    });
  });

  describe('non-retryable bucket', () => {
    it('returns workflow.run.start when the task def is gone (schema drift) AND resolver succeeded', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow(),
        // Resolver returned a workflow, but the failed task is not in it.
        resolved([task({ taskId: 'different-task', retryability: 'safe' })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.start');
      if (action?.op !== 'workflow.run.start') throw new Error('unreachable');
      expect(action.args.slug).toBe(SLUG);
      expect(action.upstreamStatePreserved).toBe(false);
      expect(action.preconditions).toContain('no longer in the current workflow definition');
    });

    it('returns workflow.run.start when the task def is gone even with a CAS token', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 3 }),
        resolved([task({ taskId: 'different-task', retryability: 'safe' })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.start');
      if (action?.op !== 'workflow.run.start') throw new Error('unreachable');
      expect(action.upstreamStatePreserved).toBe(false);
    });
  });

  describe('budget-exhausted → in-place deliberate retry (Plan 202 §3.2)', () => {
    it('offers retry_failed_task (not start), preserving upstream, with the remediationConfirmed escape hatch', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 3 }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.resume');
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      expect(action.upstreamStatePreserved).toBe(true);
      expect(action.args.resolution.mode).toBe('retry_failed_task');
      expect(action.preconditions).toContain('remediationConfirmed: true');
      expect(action.preconditions).toContain('maxAttempts=3');
    });

    it('omits remediationConfirmed from the suggested resolution (anti rubber-stamp)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 3 }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.resume') throw new Error('expected resume');
      if (action.args.resolution.mode !== 'retry_failed_task') throw new Error('unreachable');
      expect(
        (action.args.resolution as Record<string, unknown>)['remediationConfirmed'],
      ).toBeUndefined();
    });
  });

  describe('shared default maxAttempts (Plan 202 §3.0 — raised 1→3)', () => {
    it('exports the default constant', () => {
      expect(RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS).toBe(3);
    });

    it('treats omitted maxAttempts as 3 — first failed attempt → resume (retryable)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 1 }),
        // No maxAttempts on the task def → default 3 applies →
        // attempt=1 < 3 → still retryable in-place.
        resolved([task({ retryability: 'safe' })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.resume');
    });

    it('treats omitted maxAttempts as 3 — attempt=3 → in-place deliberate retry', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 3 }),
        resolved([task({ retryability: 'safe' })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.resume');
      if (action?.op !== 'workflow.run.resume') throw new Error('unreachable');
      expect(action.preconditions).toContain('remediationConfirmed: true');
      expect(action.preconditions).toContain('maxAttempts=3');
    });

    it('explicit maxAttempts=1 — first failed attempt is already budget-spent → deliberate retry', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ attempt: 1 }),
        resolved([task({ retryability: 'safe', maxAttempts: 1 })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.resume');
      if (action?.op !== 'workflow.run.resume') throw new Error('unreachable');
      expect(action.upstreamStatePreserved).toBe(true);
      expect(action.preconditions).toContain('maxAttempts=1');
    });
  });

  describe('resolver-failure path (P2 review fix)', () => {
    it('returns undefined when the workflow definition is unresolvable', () => {
      const action = buildSuggestedActionForFailedTask(failedRow(), UNRESOLVABLE, RUN_ID, SLUG);
      expect(action).toBeUndefined();
    });
  });

  describe('fresh-run preserves operator intent (P3 review fix)', () => {
    // Use the missingCas (failedAt: null) trigger to land in the start bucket.
    it('threads run-level parentInstructions into start args', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
        { parentInstructions: { runLevel: 'Optimize for SPY only.' } },
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.instructions).toBe('Optimize for SPY only.');
    });

    it('threads task-targeted parentInstructions into start args', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
        {
          parentInstructions: {
            taskTargeted: [{ taskId: 'hydrate', text: 'Use the cached snapshot.' }],
          },
        },
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.instructions).toEqual([
        { taskId: 'hydrate', text: 'Use the cached snapshot.' },
      ]);
    });

    it('threads parentTaskInputs.inputs into start args', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
        {
          parentTaskInputs: {
            taskId: 'first-task',
            inputs: { vendor: 'Alpaca', symbol: 'SPY' },
          },
        },
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.inputs).toEqual({ vendor: 'Alpaca', symbol: 'SPY' });
    });

    it('omits instructions / inputs when runMetadata has none or is malformed', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
        { parentInstructions: 'not the right shape', parentTaskInputs: 12345 },
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.instructions).toBeUndefined();
      expect(action.args.inputs).toBeUndefined();
    });

    it('omits instructions / inputs when runMetadata is undefined (no metadata threaded)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.instructions).toBeUndefined();
      expect(action.args.inputs).toBeUndefined();
    });
  });

  describe('returns undefined when the row is not surface-able', () => {
    it('non-failed row → undefined', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ status: 'succeeded' }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      expect(action).toBeUndefined();
    });
  });

  describe('missing failedAt fallback (P2 review fix #2)', () => {
    it('failed row with no failedAt → workflow.run.start with explanatory preconditions', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
      );
      expect(action?.op).toBe('workflow.run.start');
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.slug).toBe(SLUG);
      expect(action.upstreamStatePreserved).toBe(false);
      expect(action.preconditions).toContain('CAS token');
    });

    it('missing failedAt fallback threads parentInstructions / inputs same as drift bucket', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        resolved([task({ retryability: 'safe', maxAttempts: 3 })]),
        RUN_ID,
        SLUG,
        {
          parentInstructions: { runLevel: 'Optimize for SPY only.' },
          parentTaskInputs: { taskId: 'first', inputs: { vendor: 'Alpaca' } },
        },
      );
      if (action?.op !== 'workflow.run.start') throw new Error('expected start');
      expect(action.args.instructions).toBe('Optimize for SPY only.');
      expect(action.args.inputs).toEqual({ vendor: 'Alpaca' });
    });

    it('missing failedAt + unresolvable definition → still undefined (resolver-failure precedence)', () => {
      const action = buildSuggestedActionForFailedTask(
        failedRow({ failedAt: null }),
        UNRESOLVABLE,
        RUN_ID,
        SLUG,
      );
      expect(action).toBeUndefined();
    });
  });
});
