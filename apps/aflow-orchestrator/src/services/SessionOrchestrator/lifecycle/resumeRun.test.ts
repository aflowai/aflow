import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionStateSafe = vi.fn();
const mockGetStepState = vi.fn();
vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    isSessionCorrupt: vi.fn().mockResolvedValue(false),
    getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
    getStepState: (...args: unknown[]) => mockGetStepState(...args),
  };
});

import { createResumeRun } from './resumeRun.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as never;
const SESSION = '99999999-2222-3333-4444-555555555555' as never;
const STEP = '00000000-0000-4000-8000-0000000000a1' as never;
const CHILD_RUN = '11111111-2222-3333-4444-555555555555';

const resumeRun = createResumeRun({
  deps: { db: {}, redis: {}, payloadStore: {} },
} as never);

function resume() {
  return resumeRun({
    tenantId: TENANT,
    runId: SESSION,
    stepExecutionId: STEP,
    inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
    traceId: 'trace-1' as never,
    idempotencyKey: 'idem-1' as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resumeRun on a session parked on a workflow run', () => {
  it('refuses, naming the run and the ways to stop waiting on it', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: {
        status: 'PAUSED',
        currentStepExecutionId: STEP,
        pauseType: 'external_dependency',
        waitingOnWorkflowRunId: CHILD_RUN,
      },
    });

    const refusal = await resume().catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ControlConflictError);
    const conflict = refusal as ControlConflictError;
    expect(conflict.conflictCode).toBe('run_waiting_on_workflow_run');
    expect(conflict.message).toContain(CHILD_RUN);
    expect(conflict.message).toContain('workflow.run.cancel');
    expect(conflict.message).toContain('interruptRun');
    expect(mockGetStepState).not.toHaveBeenCalled();
  });

  it('lets a session paused for an operator through the guard', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { status: 'PAUSED', currentStepExecutionId: STEP, pauseType: 'user_input' },
    });
    mockGetStepState.mockResolvedValue(null);

    await expect(resume()).rejects.toThrow(/not found in Redis/);
    expect(mockGetStepState).toHaveBeenCalledOnce();
  });
});
