import { describe, expect, it } from 'vitest';
import {
  workflowRunDetailToSurfaceState,
  type WorkflowRunDetailResponse,
} from './workflowRunDetailToState.js';

const NOW = 1_700_000_000_000;

function detail(overrides?: Partial<WorkflowRunDetailResponse>): WorkflowRunDetailResponse {
  return {
    run: {
      runId: '11111111-2222-3333-4444-555555555555',
      workflowSlug: 'kaggle-optimizer',
      workflowTitle: 'Kaggle Optimizer',
      status: 'running',
      pauseVersion: 0,
      startedAt: '2026-06-06T10:00:00.000Z',
    },
    tasks: [
      { taskId: 't1', label: 'Prepare', status: 'succeeded', attempt: 1 },
      { taskId: 't2', label: 'Execute', status: 'running', attempt: 2, workerSessionId: 'sess-x' },
    ],
    graphFidelity: 'full',
    ...overrides,
  };
}

describe('workflowRunDetailToSurfaceState', () => {
  it('maps run-level + task fields and stamps lastMutatedAtMs', () => {
    const state = workflowRunDetailToSurfaceState(detail(), NOW);
    expect(state.runId).toBe('11111111-2222-3333-4444-555555555555');
    expect(state.slug).toBe('kaggle-optimizer');
    expect(state.workflowTitle).toBe('Kaggle Optimizer');
    expect(state.status).toBe('running');
    expect(state.graphFidelity).toBe('full');
    expect(state.needsHydration).toBe(false);
    expect(Object.keys(state.tasks)).toEqual(['t1', 't2']);
    expect(state.tasks['t2']?.attempt).toBe(2);
    expect(state.tasks['t2']?.workerSessionId).toBe('sess-x');
    expect(state.tasks['t1']?.lastMutatedAtMs).toBe(NOW);
  });

  it('marks terminal runs frozen', () => {
    expect(
      workflowRunDetailToSurfaceState(
        detail({ run: { ...detail().run, status: 'completed' } }),
        NOW,
      ).isFrozen,
    ).toBe(true);
    expect(workflowRunDetailToSurfaceState(detail(), NOW).isFrozen).toBe(false);
  });

  it('omits optional fields that are absent (exactOptionalPropertyTypes-safe)', () => {
    const state = workflowRunDetailToSurfaceState(
      {
        run: {
          runId: '11111111-2222-3333-4444-555555555555',
          workflowSlug: 's',
          status: 'paused',
          pauseVersion: 3,
          pausedReason: 'manual',
          startedAt: '2026-06-06T10:00:00.000Z',
        },
        tasks: [],
      },
      NOW,
    );
    expect(state.pausedReason).toBe('manual');
    expect('workflowTitle' in state).toBe(false);
    expect('graphFidelity' in state).toBe(false);
    expect(state.tasks).toEqual({});
  });

  it('maps execution refs and folds Plan-149 error columns into failure (Plan 193)', () => {
    const state = workflowRunDetailToSurfaceState(
      detail({
        tasks: [
          {
            taskId: 'render-card',
            label: 'Render card',
            status: 'failed',
            attempt: 1,
            taskType: 'operation',
            operationId: 'ui.artifact.render',
            inputRef: 'gs://b/tenants/t/runs/r/steps/s/attempt/1/resolved_input.json',
            outputRef: 'gs://b/tenants/t/runs/r/steps/s/attempt/1/output.json',
            errorRef: 'gs://b/tenants/t/runs/r/steps/s/attempt/1/error.json',
            errorCode: 'EGRESS_HTTP_400',
            errorClassification: 'external_dependency',
            errorRetryable: false,
            failureReason: 'render failed',
          },
          { taskId: 'plain', label: 'Plain', status: 'succeeded', attempt: 1 },
        ],
      }),
      NOW,
    );
    const failed = state.tasks['render-card'];
    expect(failed?.inputRef).toContain('resolved_input.json');
    expect(failed?.outputRef).toContain('output.json');
    expect(failed?.errorRef).toContain('error.json');
    expect(failed?.failure).toEqual({
      code: 'EGRESS_HTTP_400',
      classification: 'external_dependency',
      retryable: false,
    });
    // No error columns → no fabricated failure; no refs → fields omitted.
    const plain = state.tasks['plain'];
    expect('failure' in (plain ?? {})).toBe(false);
    expect('inputRef' in (plain ?? {})).toBe(false);
  });

  it('extracts allowedResumeModes from the resume contract (Plan 182 §2.6)', () => {
    const base = detail();
    const interrupt = workflowRunDetailToSurfaceState(
      { ...base, resumeContract: { allowedResumeModes: ['re_execute', 'fail'] } },
      NOW,
    );
    expect(interrupt.allowedResumeModes).toEqual(['re_execute', 'fail']);

    const softQuiesce = workflowRunDetailToSurfaceState(
      { ...base, resumeContract: { allowedResumeModes: ['acknowledge'] } },
      NOW,
    );
    expect(softQuiesce.allowedResumeModes).toEqual(['acknowledge']);

    // No contract (running run) → undefined.
    expect(workflowRunDetailToSurfaceState(base, NOW).allowedResumeModes).toBeUndefined();
  });
});
