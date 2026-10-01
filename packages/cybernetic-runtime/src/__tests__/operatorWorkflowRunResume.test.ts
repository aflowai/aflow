import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { getWriteApprovalGrant, hostPushRequestHash, writeApprovalGrantKey } from '@aflow/redis';
import type { TenantId, WorkflowRunResumeInput } from '@aflow/schemas';

const mockLoadRunById = vi.fn();
const mockClaimResumeLease = vi.fn();
const mockReleaseResumeClaim = vi.fn();
const mockResumeRunWithClaim = vi.fn();
const mockSurfaceContract = vi.fn();
const mockEmitWorkflowProgress = vi.fn();
const mockResolveWorkflowForRunRevision = vi.fn();
const mockApplyFailTaskResolution = vi.fn();
const mockApplyRejectResolution = vi.fn();
const mockCommitReExecute = vi.fn();

const mockBumpResumeAttemptCount = vi.fn();
const mockCommitReplaceOutput = vi.fn();

vi.mock('../ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger.js')>();
  return {
    ...actual,
    bumpResumeAttemptCount: (...args: unknown[]) => mockBumpResumeAttemptCount(...args),
    commitReplaceOutputAndResume: (...args: unknown[]) => mockCommitReplaceOutput(...args),
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    claimResumeLease: (...args: unknown[]) => mockClaimResumeLease(...args),
    releaseResumeClaim: (...args: unknown[]) => mockReleaseResumeClaim(...args),
    resumeRunWithClaim: (...args: unknown[]) => mockResumeRunWithClaim(...args),
    commitReExecutePausedTaskAndResume: (...args: unknown[]) => mockCommitReExecute(...args),
  };
});

vi.mock('../workflowResume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflowResume.js')>();
  return {
    ...actual,
    surfaceWorkflowResumeContract: (...args: unknown[]) => mockSurfaceContract(...args),
  };
});

vi.mock('../workflowRunProgress.js', () => ({
  emitWorkflowProgress: (...args: unknown[]) => mockEmitWorkflowProgress(...args),
  // Stub mirrors the real helper: one skipped WorkflowTaskUpdate per descendant,
  // routed through the same emit mock so tests can assert on them.
  emitRejectedBranchSkips: async (
    deps: unknown,
    a: { tenantId: string; runId: string; skipped: Array<{ taskId: string; label: string }> },
  ) => {
    for (const { taskId, label } of a.skipped) {
      await mockEmitWorkflowProgress(deps, {
        tenantId: a.tenantId,
        runId: a.runId,
        event: {
          kind: 'WorkflowTaskUpdate',
          payload: { runId: a.runId, taskId, label, status: 'skipped', attempt: 1 },
        },
      });
    }
  },
}));

vi.mock('../workflowRunResumeModes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflowRunResumeModes.js')>();
  return {
    ...actual,
    applyFailTaskResolution: (...args: unknown[]) => mockApplyFailTaskResolution(...args),
    applyRejectResolution: (...args: unknown[]) => mockApplyRejectResolution(...args),
  };
});

vi.mock('../userLabels.js', () => ({
  resolveUserLabel: vi.fn().mockResolvedValue('Test Operator'),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    resolveWorkflowForRunRevision: (...args: unknown[]) =>
      mockResolveWorkflowForRunRevision(...args),
  };
});

const { executeOperatorWorkflowRunResume } = await import('../operatorWorkflowRunResume.js');

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '11111111-2222-3333-4444-555555555555';
const SPACE_ID = 'space-1';

const deps = { db: {} as never, redis: {} as never, payloadStore: {} as never };

function ackInput(): WorkflowRunResumeInput {
  return {
    runId: RUN_ID,
    pauseVersion: 1,
    resolution: { mode: 'acknowledge' },
  } as WorkflowRunResumeInput;
}

function failInput(reason = 'not good enough'): WorkflowRunResumeInput {
  return {
    runId: RUN_ID,
    pauseVersion: 1,
    resolution: { mode: 'fail', reason },
  } as WorkflowRunResumeInput;
}

function rejectInput(comment?: string): WorkflowRunResumeInput {
  return {
    runId: RUN_ID,
    pauseVersion: 1,
    resolution: { mode: 'reject', ...(comment ? { comment } : {}) },
  } as WorkflowRunResumeInput;
}

const hooks = {
  applyFailureMode: vi.fn().mockResolvedValue(undefined),
  dispatchNextOrTerminate: vi.fn().mockResolvedValue(undefined),
  dispatchRetriedTask: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  configureLogging({ service: 'test', level: 'silent' });
  vi.clearAllMocks();
  mockEmitWorkflowProgress.mockResolvedValue(undefined);
  mockResolveWorkflowForRunRevision.mockResolvedValue({
    workflow: { slug: 'test-skill', tasks: [] },
  });
  mockClaimResumeLease.mockResolvedValue({ ok: true, claim: { claimToken: 'tok' } });
  mockReleaseResumeClaim.mockResolvedValue(undefined);
  // Manual run-level pause: acknowledge allowed, NOT a HITL focus, no failedTaskId.
  mockSurfaceContract.mockResolvedValue({
    pauseVersion: 1,
    contract: {
      pauseCause: 'manual',
      allowedResumeModes: ['acknowledge'],
      suggestedResumeCall: { op: 'workflow.run.resume', args: {} },
    },
  });
});

describe('executeOperatorWorkflowRunResume — acknowledge emits WorkflowRunUpdate(running)', () => {
  it('emits a live running run-update after a successful acknowledge resume', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
    });
    mockResumeRunWithClaim.mockResolvedValue(true);

    const result = await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    expect(result).toEqual({ ok: true, runId: RUN_ID });

    // The fix: a run-level WorkflowRunUpdate(running) was emitted so the
    // surface card flips paused → running.
    const runUpdate = mockEmitWorkflowProgress.mock.calls.find((c) => {
      const arg = c[1] as { event?: { kind?: string; payload?: { status?: string } } };
      return arg.event?.kind === 'WorkflowRunUpdate';
    });
    expect(runUpdate).toBeDefined();
    const payload = (runUpdate![1] as { event: { payload: Record<string, unknown> } }).event
      .payload;
    expect(payload).toMatchObject({ runId: RUN_ID, slug: 'test-skill', status: 'running' });

    // And the run was actually driven forward.
    expect(hooks.dispatchNextOrTerminate).toHaveBeenCalledOnce();
  });

  it('emits the running update BEFORE driving the run forward', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
    });
    mockResumeRunWithClaim.mockResolvedValue(true);

    await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    const emitOrder = mockEmitWorkflowProgress.mock.invocationCallOrder[0];
    const dispatchOrder = hooks.dispatchNextOrTerminate.mock.invocationCallOrder[0];
    expect(emitOrder).toBeLessThan(dispatchOrder!);
  });

  it('does NOT emit a running update when the run is not paused (stale)', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'running',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
    });

    const result = await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    expect(result).toMatchObject({ ok: false, code: 'RUN_NOT_PAUSED' });
    expect(mockEmitWorkflowProgress).not.toHaveBeenCalled();
    expect(mockResumeRunWithClaim).not.toHaveBeenCalled();
  });
});

describe('executeOperatorWorkflowRunResume — startup preflight pauses are not acknowledgeable', () => {
  // A startup preflight pause is raised before any task exists, so it carries
  // no failedTaskId and the task-backed guard does not catch it. Acknowledging
  // it here would release the run without re-running the preflight, and its
  // operation tasks dispatch directly without passing step gating.
  function pausedRun() {
    return {
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
    };
  }

  it('refuses an operator acknowledge of a needs_capability startup pause and releases the claim', async () => {
    mockLoadRunById.mockResolvedValue(pausedRun());
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: { pauseCause: 'needs_capability', allowedResumeModes: ['acknowledge'] },
    });

    const result = await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'ACKNOWLEDGE_CAPABILITY_PAUSE_NOT_SUPPORTED',
    });
    expect(mockResumeRunWithClaim).not.toHaveBeenCalled();
    expect(hooks.dispatchNextOrTerminate).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalled();
  });

  it('still allows an operator acknowledge of a needs_credentials pause — the call refuses on its own', async () => {
    // Pre-existing route: a credentials gap surfaces at the call itself, so
    // refusing here would withdraw a path operators already use.
    mockLoadRunById.mockResolvedValue(pausedRun());
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: { pauseCause: 'needs_credentials', allowedResumeModes: ['acknowledge'] },
    });

    const result = await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    expect(result).toMatchObject({ ok: true });
    expect(mockResumeRunWithClaim).toHaveBeenCalled();
  });

  it('still allows an operator acknowledge of an ordinary manual pause', async () => {
    mockLoadRunById.mockResolvedValue(pausedRun());
    mockResumeRunWithClaim.mockResolvedValue(true);

    const result = await executeOperatorWorkflowRunResume(
      deps,
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input: ackInput() },
      hooks,
    );

    expect(result).toEqual({ ok: true, runId: RUN_ID });
    expect(mockResumeRunWithClaim).toHaveBeenCalled();
  });
});

describe('executeOperatorWorkflowRunResume — fail emits WorkflowTaskUpdate(failed)', () => {
  const TASK_ID = 'approve-submit';

  beforeEach(() => {
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: {
        pauseCause: 'needs_decision',
        failedTaskId: TASK_ID,
        allowedResumeModes: ['replace_output', 'fail'],
        suggestedResumeCall: { op: 'workflow.run.resume', args: {} },
      },
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: TASK_ID, name: 'Approve submission' }],
      },
    });
    mockApplyFailTaskResolution.mockResolvedValue({ ok: true, failedTaskId: TASK_ID });
  });

  it('emits a live failed task-update with humanDecision after operator reject', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
      tasks: [{ taskId: TASK_ID, status: 'paused', attempt: 1 }],
    });

    const result = await executeOperatorWorkflowRunResume(
      deps,
      {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        userId: 'user-1',
        input: failInput('bad data quality'),
      },
      hooks,
    );

    expect(result).toEqual({ ok: true, runId: RUN_ID });

    const taskUpdate = mockEmitWorkflowProgress.mock.calls.find((c) => {
      const arg = c[1] as { event?: { kind?: string; payload?: { status?: string } } };
      return arg.event?.kind === 'WorkflowTaskUpdate';
    });
    expect(taskUpdate).toBeDefined();
    const payload = (taskUpdate![1] as { event: { payload: Record<string, unknown> } }).event
      .payload;
    expect(payload).toMatchObject({
      runId: RUN_ID,
      taskId: TASK_ID,
      status: 'failed',
      taskType: 'human',
      failureReason: 'bad data quality',
      humanDecision: {
        decision: 'rejected',
        decidedBy: 'Test Operator',
        comment: 'bad data quality',
      },
    });

    expect(hooks.applyFailureMode).toHaveBeenCalledWith(deps, TENANT, RUN_ID, TASK_ID);
    expect(hooks.dispatchNextOrTerminate).not.toHaveBeenCalled();
  });
});

describe('executeOperatorWorkflowRunResume — re_execute validates instruction targets', () => {
  const TASK_ID = 'execute';

  beforeEach(() => {
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: {
        pauseCause: 'task_paused',
        failedTaskId: TASK_ID,
        allowedResumeModes: ['re_execute', 'fail'],
        suggestedResumeCall: { op: 'workflow.run.resume', args: {} },
      },
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [
          { taskId: TASK_ID, name: 'Execute', type: 'agent' },
          { taskId: 'approve-submit', name: 'Approve submission', type: 'human' },
        ],
      },
    });
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
      tasks: [{ taskId: TASK_ID, status: 'paused', attempt: 1 }],
    });
  });

  function reExecuteInput(
    instructions: WorkflowRunResumeInput['resolution'] extends { instructions?: infer I }
      ? I
      : never,
  ): WorkflowRunResumeInput {
    return {
      runId: RUN_ID,
      pauseVersion: 1,
      resolution: { mode: 're_execute', instructions },
    } as WorkflowRunResumeInput;
  }

  it('rejects instructions addressed to an unknown taskId before committing, releasing the claim', async () => {
    const result = await executeOperatorWorkflowRunResume(
      deps,
      {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        userId: 'user-1',
        input: reExecuteInput([{ taskId: 'explore-data', text: 'do the thing' }]),
      },
      hooks,
    );

    expect(result).toMatchObject({ ok: false, code: 'INSTRUCTION_TARGETS_INVALID' });
    const message = (result as { message: string }).message;
    expect(message).toContain('explore-data');
    expect(message).toContain(TASK_ID);
    expect(message).not.toContain('workflow.run.start');
    expect(mockCommitReExecute).not.toHaveBeenCalled();
    expect(mockResumeRunWithClaim).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalled();
  });

  it('an instruction addressed to the paused agent task still commits with the patch', async () => {
    mockCommitReExecute.mockResolvedValue('committed');

    const result = await executeOperatorWorkflowRunResume(
      deps,
      {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        userId: 'user-1',
        input: reExecuteInput([{ taskId: TASK_ID, text: 'retry with fewer folds' }]),
      },
      hooks,
    );

    expect(result).toEqual({ ok: true, runId: RUN_ID });
    expect(mockCommitReExecute).toHaveBeenCalledOnce();
    const commitArgs = mockCommitReExecute.mock.calls[0]![2] as Record<string, unknown>;
    expect(commitArgs['parentInstructionsPatch']).toBeDefined();
  });
});

describe('executeOperatorWorkflowRunResume — reject skips the gated branch (reject-but-learn)', () => {
  const TASK_ID = 'approve-submit';

  beforeEach(() => {
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: {
        pauseCause: 'needs_decision',
        failedTaskId: TASK_ID,
        allowedResumeModes: ['replace_output', 'reject', 'fail'],
        suggestedResumeCall: { op: 'workflow.run.resume', args: {} },
      },
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [
          { taskId: TASK_ID, name: 'Approve submission' },
          { taskId: 'submit-finalize', name: 'Finalize submission' },
          { taskId: 'poll-lb', name: 'Poll leaderboard' },
        ],
      },
    });
    mockApplyRejectResolution.mockResolvedValue({
      ok: true,
      skippedTaskId: TASK_ID,
      skippedDescendantTaskIds: ['submit-finalize', 'poll-lb'],
    });
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'test-skill',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
      tasks: [{ taskId: TASK_ID, status: 'paused', attempt: 1 }],
    });
  });

  it('emits a skipped task-update and drives the run forward, NOT applyFailureMode', async () => {
    const result = await executeOperatorWorkflowRunResume(
      deps,
      {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        userId: 'user-1',
        input: rejectInput('not worth a daily submission'),
      },
      hooks,
    );

    expect(result).toEqual({ ok: true, runId: RUN_ID });

    const taskUpdate = mockEmitWorkflowProgress.mock.calls.find((c) => {
      const arg = c[1] as { event?: { kind?: string } };
      return arg.event?.kind === 'WorkflowTaskUpdate';
    });
    expect(taskUpdate).toBeDefined();
    const payload = (taskUpdate![1] as { event: { payload: Record<string, unknown> } }).event
      .payload;
    expect(payload).toMatchObject({
      runId: RUN_ID,
      taskId: TASK_ID,
      status: 'skipped',
      taskType: 'human',
      humanIntent: 'approve',
      humanDecision: {
        decision: 'rejected',
        decidedBy: 'Test Operator',
        comment: 'not worth a daily submission',
      },
    });

    // Reject continues the run (learning tasks); it must NOT block descendants.
    expect(hooks.dispatchNextOrTerminate).toHaveBeenCalledWith(deps, TENANT, RUN_ID);
    expect(hooks.applyFailureMode).not.toHaveBeenCalled();

    // The gated-branch descendants the commit pre-skipped also get live skipped
    // updates (so they leave the forward-DAG ghost state without a refetch).
    const skippedDescendantUpdates = mockEmitWorkflowProgress.mock.calls
      .map(
        (c) =>
          c[1] as { event?: { kind?: string; payload?: { taskId?: string; status?: string } } },
      )
      .filter(
        (a) => a.event?.kind === 'WorkflowTaskUpdate' && a.event?.payload?.status === 'skipped',
      )
      .map((a) => a.event!.payload!.taskId);
    expect(skippedDescendantUpdates).toEqual(
      expect.arrayContaining([TASK_ID, 'submit-finalize', 'poll-lb']),
    );
  });
});

describe('executeOperatorWorkflowRunResume — the operator approving a host push mints its grant', () => {
  const TASK_ID = 'approve-push';
  const PUSH = {
    bindingId: 'folder-1',
    refspec: `${'c'.repeat(40)}:refs/heads/aflow/x`,
    receipt: 'receipt-unscanned',
  };

  /** Just the two commands the grant store issues, over a map. */
  function grantRedis() {
    const keys = new Map<string, string>();
    return {
      keys,
      redis: {
        set: vi.fn((key: string, value: string) => {
          keys.set(key, value);
          return Promise.resolve('OK');
        }),
        get: (key: string) => Promise.resolve(keys.get(key) ?? null),
      },
    };
  }

  function approveInput(approvedCall: { op: string; input: unknown }): WorkflowRunResumeInput {
    return {
      runId: RUN_ID,
      pauseVersion: 1,
      resolution: { mode: 'replace_output', output: { decision: 'approved', approvedCall } },
    } as WorkflowRunResumeInput;
  }

  beforeEach(() => {
    mockSurfaceContract.mockResolvedValue({
      pauseVersion: 1,
      contract: {
        pauseCause: 'needs_decision',
        failedTaskId: TASK_ID,
        allowedResumeModes: ['replace_output', 'reject', 'fail'],
        suggestedResumeCall: { op: 'workflow.run.resume', args: {} },
      },
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'local-publish',
        tasks: [
          {
            taskId: TASK_ID,
            name: 'Approve the push',
            type: 'human',
            intent: 'approve',
            actionPreview: { op: 'host.process.exec', input: PUSH },
          },
          { taskId: 'push', name: 'Push the commit' },
        ],
      },
    });
    mockLoadRunById.mockResolvedValue({
      runId: RUN_ID,
      spaceId: SPACE_ID,
      status: 'paused',
      workflowSlug: 'local-publish',
      workflowRevision: 1,
      resumeAttemptCount: 0,
      pauseVersion: 1,
      startedAt: new Date('2026-06-06T00:00:00Z'),
      tasks: [{ taskId: TASK_ID, status: 'paused', attempt: 1 }],
    });
    mockBumpResumeAttemptCount.mockResolvedValue(1);
    mockCommitReplaceOutput.mockResolvedValue('committed');
    mockApplyRejectResolution.mockResolvedValue({
      ok: true,
      skippedTaskId: TASK_ID,
      skippedDescendantTaskIds: ['push'],
    });
  });

  async function resume(input: WorkflowRunResumeInput) {
    const { keys, redis } = grantRedis();
    const result = await executeOperatorWorkflowRunResume(
      {
        db: {} as never,
        redis: redis as never,
        payloadStore: { store: () => Promise.resolve('payload:approval') } as never,
      },
      { tenantId: TENANT, spaceId: SPACE_ID, userId: 'user-1', input },
      hooks,
    );
    return { result, keys, redis };
  }

  it('grants exactly the approved push, keyed by tenant, run and its hash, before anything dispatches it', async () => {
    const { result, keys, redis } = await resume(
      approveInput({ op: 'host.process.exec', input: { ...PUSH, branch: 'aflow/x' } }),
    );
    expect(result).toEqual({ ok: true, runId: RUN_ID });

    const requestHash = hostPushRequestHash(PUSH);
    const grant = await getWriteApprovalGrant(redis as never, TENANT, RUN_ID, requestHash);
    expect(grant).toMatchObject({ requestHash, decision: 'approved', approvedBy: 'user-1' });
    expect([...keys.keys()]).toEqual([writeApprovalGrantKey(TENANT, RUN_ID, requestHash)]);
    // Written before the approval commits, so the push the commit releases finds it.
    const minted = redis.set.mock.invocationCallOrder[0] ?? Infinity;
    expect(minted).toBeLessThan(mockCommitReplaceOutput.mock.invocationCallOrder[0] ?? -1);
    expect(hooks.dispatchNextOrTerminate).toHaveBeenCalledOnce();
  });

  it('mints nothing for an approved call that is not a push', async () => {
    const { result, keys } = await resume(
      approveInput({ op: 'kaggle.submit', input: { path: '/tmp/submission.csv' } }),
    );
    expect(result).toEqual({ ok: true, runId: RUN_ID });
    expect(keys.size).toBe(0);
  });

  it('mints nothing when the operator declines the push', async () => {
    const { result, keys } = await resume(rejectInput('not this one'));
    expect(result).toEqual({ ok: true, runId: RUN_ID });
    expect(mockApplyRejectResolution).toHaveBeenCalledOnce();
    expect(keys.size).toBe(0);
  });
});
