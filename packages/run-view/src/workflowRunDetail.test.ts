import { describe, expect, it } from 'vitest';
import { HARNESS_RUN_OPERATION } from './op-labels.js';
import type { WorkflowSurfaceTaskState } from './types.js';
import {
  MOUNT_INLINE_REF_MAX,
  projectRunForMount,
  projectTaskForMount,
  runSurfaceNeedsDetailRead,
  runSurfaceOutputs,
  workflowRunDetailToSurfaceState,
  type WorkflowRunDetailResponse,
} from './workflowRunDetail.js';

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

  it('holds the output bag once — on `outputs`, not again on `result.output`', () => {
    const output = { report: 'x'.repeat(5_000) };
    const state = workflowRunDetailToSurfaceState(
      detail({ result: { output, summary: 'done', primaryOutput: 'report' } }),
      NOW,
    );
    expect(state.outputs).toEqual(output);
    expect(state.result).toEqual({ summary: 'done', primaryOutput: 'report' });
    expect(JSON.stringify(state).split('x'.repeat(5_000)).length - 1).toBe(1);
  });
});

/**
 * A client renders the output rows from whichever field holds the bag, so a
 * state written in the earlier shape — the bag on `result.output` only, or on
 * both — renders the same rows as the split one.
 */
describe('runSurfaceOutputs', () => {
  const bag = { score: 0.9 };

  it('reads the split shape', () => {
    expect(runSurfaceOutputs({ outputs: bag, result: { summary: 's' } })).toBe(bag);
  });

  it('reads a state that keeps the bag on result.output only', () => {
    expect(runSurfaceOutputs({ result: { output: bag } })).toBe(bag);
  });

  it('reads a state that carries the bag on both fields', () => {
    expect(runSurfaceOutputs({ outputs: bag, result: { output: { ...bag } } })).toBe(bag);
  });

  it('answers nothing for a run with no output', () => {
    expect(runSurfaceOutputs({})).toBeUndefined();
  });
});

describe('runSurfaceNeedsDetailRead', () => {
  const hydrated = workflowRunDetailToSurfaceState(detail(), NOW);

  it('lets a run with its graph mount without a read', () => {
    expect(runSurfaceNeedsDetailRead(hydrated)).toBe(false);
  });

  it('reads the detail for a run the live stream left without a graph', () => {
    const rest = { ...hydrated };
    delete rest.graphFidelity;
    expect(runSurfaceNeedsDetailRead(rest)).toBe(true);
  });

  it('reads the detail for a sparse seed or an absent run', () => {
    expect(runSurfaceNeedsDetailRead({ ...hydrated, needsHydration: true })).toBe(true);
    expect(runSurfaceNeedsDetailRead(undefined)).toBe(true);
  });
});

describe('projectRunForMount', () => {
  const bigInline = `inline:output:${'A'.repeat(MOUNT_INLINE_REF_MAX)}`;
  const smallInline = 'inline:input:eyJhIjoxfQ==';
  const pointer = 'gs://b/tenants/t/runs/r/steps/s/attempt/1/output.json';

  function task(overrides: Partial<WorkflowSurfaceTaskState>): WorkflowSurfaceTaskState {
    return {
      taskId: 't',
      label: 'T',
      status: 'succeeded',
      attempt: 1,
      lastMutatedAtMs: NOW,
      ...overrides,
    };
  }

  it('drops the refs of a task the card never reads them for', () => {
    const projected = projectTaskForMount(
      task({ taskType: 'agent', inputRef: bigInline, outputRef: pointer }),
    );
    expect(projected.inputRef).toBeUndefined();
    expect(projected.outputRef).toBeUndefined();
    expect(projected.refsElided).toBeUndefined();
  });

  it('keeps every ref of a harness task, whose card reads them on mount', () => {
    const harness = task({
      taskType: 'operation',
      operationId: HARNESS_RUN_OPERATION,
      inputRef: bigInline,
      outputRef: pointer,
    });
    expect(projectTaskForMount(harness)).toBe(harness);
  });

  it('elides a large inline ref of another operation task and marks it', () => {
    const projected = projectTaskForMount(
      task({
        taskType: 'operation',
        operationId: 'host.command.run',
        inputRef: smallInline,
        outputRef: bigInline,
        errorRef: pointer,
      }),
    );
    expect(projected).toMatchObject({ inputRef: smallInline, errorRef: pointer, refsElided: true });
    expect(projected.outputRef).toBeUndefined();
  });

  it('moves result.output to outputs on a state written in the earlier shape', () => {
    const output = { report: 'r' };
    const state = {
      ...workflowRunDetailToSurfaceState(detail(), NOW),
      result: { output, summary: 's' },
    };
    const projected = projectRunForMount(state);
    expect(projected.outputs).toEqual(output);
    expect(projected.result).toEqual({ summary: 's' });
  });
});
