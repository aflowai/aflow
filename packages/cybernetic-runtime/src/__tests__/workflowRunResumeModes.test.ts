import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow, WorkflowResumeContract } from '@aflow/schemas';
import { HumanApprovalResolutionInputSchema, HumanApprovalOutputSchema } from '@aflow/schemas';

const mockBump = vi.fn();
const mockCommitReplace = vi.fn();
const mockCommitFail = vi.fn();
const mockStore = vi.fn();

vi.mock('../ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger.js')>();
  return {
    ...actual,
    bumpResumeAttemptCount: (...args: unknown[]) => mockBump(...args),
    commitReplaceOutputAndResume: (...args: unknown[]) => mockCommitReplace(...args),
    commitFailTaskAndResume: (...args: unknown[]) => mockCommitFail(...args),
    // `runContextFromDetail` loads the run's campaign for `campaign_input`
    // bindings; this stub db can't run the query, and these skills are
    // campaign-less, so resolve to "no campaign".
    getRunCampaignId: () => Promise.resolve(null),
  };
});

vi.mock('../resumeAjv.js', () => ({
  getResumeAjv: () => ({
    compile: () => () => true,
  }),
}));

const { applyHumanReplaceOutputResolution, applyFailTaskResolution } =
  await import('../workflowRunResumeModes.js');

// Sanity — schemas must be available (guards against export drift).
void HumanApprovalResolutionInputSchema;
void HumanApprovalOutputSchema;

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const TASK_ID = 'approve-submit';

const workflow = {
  slug: 'test-skill',
  name: 'Test',
  mode: 'skill',
  status: 'approved',
  revision: 1,
  tasks: [
    {
      taskId: TASK_ID,
      name: 'Approve submit',
      type: 'human',
      intent: 'approve',
      actionPreview: { op: 'kaggle.submit', input: { path: '/tmp/sub.csv' } },
      failureMode: 'isolate',
    },
  ],
  outcomes: [],
} as Workflow;

const surfaced = {
  pauseVersion: 1,
  contract: {
    pauseCause: 'needs_decision',
    allowedResumeModes: ['replace_output', 'fail'],
    resumePrompt: 'Approve?',
    failedTaskId: TASK_ID,
    suggestedResumeCall: {
      op: 'workflow.run.resume',
      args: { runId: RUN_ID, pauseVersion: 1, resolution: { mode: 'replace_output', output: {} } },
    },
  } as WorkflowResumeContract,
};

const run = {
  runId: RUN_ID,
  workflowSlug: 'test-skill',
  workflowRevision: 1,
  spaceId: 'space-1',
  status: 'paused' as const,
  pauseVersion: 1,
  resumeAttemptCount: 0,
  tasks: [{ taskId: TASK_ID, status: 'paused' as const, attempt: 1 }],
};

describe('applyHumanReplaceOutputResolution — approve echo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBump.mockResolvedValue(1);
    mockCommitReplace.mockResolvedValue('committed');
    mockStore.mockResolvedValue('payload:output-1');
  });

  it('echoes actionPreview into approvedCall when client omits it', async () => {
    const payloadStore = { store: mockStore };
    const result = await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow,
      surfaced,
      output: { decision: 'approved' },
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: payloadStore as never,
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
    expect(result.ok).toBe(true);
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'approved',
          approvedCall: { op: 'kaggle.submit', input: { path: '/tmp/sub.csv' } },
          decidedBy: 'user-1',
        }),
      }),
    );
  });

  it('accepts the previewed call sent back unchanged', async () => {
    const payloadStore = { store: mockStore };
    const result = await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow,
      surfaced,
      output: {
        decision: 'approved',
        approvedCall: { op: 'kaggle.submit', input: { path: '/tmp/sub.csv' } },
      },
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: payloadStore as never,
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
    expect(result.ok).toBe(true);
    expect(mockCommitReplace).toHaveBeenCalledOnce();
  });

  it('refuses a client approvedCall that differs from the preview, naming where, and persists nothing', async () => {
    const payloadStore = { store: mockStore };
    const result = await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow,
      surfaced,
      output: {
        decision: 'approved',
        approvedCall: { op: 'kaggle.submit', input: { path: '/edited.csv', force: true } },
      },
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: payloadStore as never,
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('APPROVED_CALL_MISMATCH');
      expect(result.error.message).toContain('at `input.force`, `input.path`.');
      expect(result.error.message).toContain('The approval was not persisted.');
    }
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockCommitReplace).not.toHaveBeenCalled();
  });
});

describe('applyHumanReplaceOutputResolution — the boundary records the approval', () => {
  const PUSH = {
    bindingId: 'folder-1',
    refspec: `${'c'.repeat(40)}:refs/heads/aflow/x`,
    receipt: 'receipt-unscanned',
  };
  const pushWorkflow = {
    ...workflow,
    tasks: [
      {
        taskId: TASK_ID,
        name: 'Approve the push',
        type: 'human',
        intent: 'approve',
        actionPreview: { op: 'host.process.exec', input: PUSH },
        failureMode: 'isolate',
      },
    ],
  } as Workflow;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBump.mockResolvedValue(1);
    mockCommitReplace.mockImplementation(
      (_db: unknown, _tenant: unknown, args: { recordWithinCommit?: () => Promise<void> }) =>
        args.recordWithinCommit
          ? args.recordWithinCommit().then(
              () => 'committed',
              () => 'record_failed',
            )
          : Promise.resolve('committed'),
    );
    mockStore.mockResolvedValue('payload:output-1');
  });

  function resolve(
    output: unknown,
    recordApproval?: (call: unknown) => Promise<void>,
    on: Workflow = workflow,
  ) {
    return applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow: on,
      surfaced,
      output,
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: { store: mockStore } as never,
      ...(recordApproval ? { recordApproval } : {}),
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
  }

  it('hands it the resolved preview within the approval commit', async () => {
    const recordApproval = vi.fn(() => Promise.resolve());
    const result = await resolve({ decision: 'approved' }, recordApproval);
    expect(result.ok).toBe(true);
    expect(recordApproval).toHaveBeenCalledWith({
      op: 'kaggle.submit',
      input: { path: '/tmp/sub.csv' },
    });
    const recorded = recordApproval.mock.invocationCallOrder[0] ?? -1;
    expect(recorded).toBeGreaterThan(mockCommitReplace.mock.invocationCallOrder[0] ?? Infinity);
  });

  it('fails an approval whose record throws, under its own code', async () => {
    const recordApproval = vi.fn(() => Promise.reject(new Error('redis down')));
    const result = await resolve({ decision: 'approved' }, recordApproval);
    expect(result).toMatchObject({ ok: false, error: { code: 'APPROVAL_NOT_RECORDED' } });
  });

  it('records nothing for an approval that did not land', async () => {
    for (const outcome of ['claim_lost', 'task_row_not_paused'] as const) {
      mockCommitReplace.mockResolvedValueOnce(outcome);
      const recordApproval = vi.fn(() => Promise.resolve());
      const result = await resolve({ decision: 'approved' }, recordApproval);
      expect(result.ok, outcome).toBe(false);
      expect(recordApproval, outcome).not.toHaveBeenCalled();
    }

    const recordApproval = vi.fn(() => Promise.resolve());
    const invalid = await resolve({ decision: 'rejected' }, recordApproval);
    expect(invalid.ok).toBe(false);
    expect(recordApproval).not.toHaveBeenCalled();
  });

  it('records nothing for a task without actionPreview, whatever approvedCall says', async () => {
    const recordApproval = vi.fn(() => Promise.resolve());
    const unpreviewed = {
      ...pushWorkflow,
      tasks: [{ taskId: TASK_ID, name: 'Approve', type: 'human', intent: 'approve' }],
    } as Workflow;
    const result = await resolve(
      { decision: 'approved', approvedCall: { op: 'host.process.exec', input: PUSH } },
      recordApproval,
      unpreviewed,
    );
    expect(result.ok).toBe(true);
    expect(recordApproval).not.toHaveBeenCalled();
  });

  it('refuses a push approval from a resolver that is not the operator, spending and persisting nothing', async () => {
    const result = await resolve({ decision: 'approved' }, undefined, pushWorkflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PUSH_APPROVAL_OPERATOR_ONLY');
      expect(result.error.message).toContain("a push's approval is the operator's to give");
      expect(result.error.message).toContain('the task is still paused');
    }
    expect(mockBump).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockCommitReplace).not.toHaveBeenCalled();

    const recordApproval = vi.fn(() => Promise.resolve());
    const operators = await resolve({ decision: 'approved' }, recordApproval, pushWorkflow);
    expect(operators.ok).toBe(true);
    expect(recordApproval).toHaveBeenCalledWith({ op: 'host.process.exec', input: PUSH });
  });
});

describe('applyFailTaskResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommitFail.mockResolvedValue('committed');
  });

  it('commits fail and returns failedTaskId', async () => {
    const result = await applyFailTaskResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      surfaced,
      reason: 'rejected_by_operator',
      claimToken: 'claim-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.failedTaskId).toBe(TASK_ID);
    }
  });
});

describe('applyHumanReplaceOutputResolution — inputBindings resolution', () => {
  // The smoke-test workflow: an `execute` task produces a submission
  // payload; `approve-submit` previews it via inputBindings; the
  // downstream op is meant to consume the resolved approvedCall.input.
  const workflowWithBindings = {
    slug: 'test-skill',
    name: 'Test',
    mode: 'skill',
    status: 'approved',
    revision: 1,
    tasks: [
      {
        taskId: 'execute',
        name: 'Execute',
        type: 'agent',
      },
      {
        taskId: TASK_ID,
        name: 'Approve submit',
        type: 'human',
        intent: 'approve',
        failureMode: 'isolate',
        dependsOn: ['execute'],
        actionPreview: {
          op: 'mcp.tool.call',
          inputBindings: {
            filePath: {
              kind: 'task_output' as const,
              taskId: 'execute',
              path: 'submission.filePath',
            },
            message: {
              kind: 'task_output' as const,
              taskId: 'execute',
              path: 'submission.message',
            },
          },
        },
      },
    ],
    outcomes: [],
  } as Workflow;

  // Run detail with `execute` succeeded — its outputRef carries a
  // structured submission payload that the bindings reference.
  const SUBMISSION_PAYLOAD = {
    submission: {
      filePath: '/tmp/submission.csv',
      message: 'iteration 1 — first attempt',
    },
  };
  const inlineExecuteOutput = `inline:${Buffer.from(JSON.stringify(SUBMISSION_PAYLOAD)).toString('base64')}`;
  const runWithExecuteOutput = {
    runId: RUN_ID,
    workflowSlug: 'test-skill',
    workflowRevision: 1,
    spaceId: 'space-1',
    status: 'paused' as const,
    pauseVersion: 2,
    resumeAttemptCount: 0,
    tasks: [
      {
        taskId: 'execute',
        status: 'succeeded' as const,
        attempt: 1,
        outputRef: inlineExecuteOutput,
        summary: null,
      },
      {
        taskId: TASK_ID,
        status: 'paused' as const,
        attempt: 1,
        outputRef: null,
        summary: null,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockBump.mockResolvedValue(2);
    mockCommitReplace.mockResolvedValue('committed');
    mockStore.mockResolvedValue('payload:output-resolved');
  });

  // Pass 3 review Finding 2 — strict at approve-echo. When upstream task
  // outputs are missing (e.g. execute hasn't completed yet — shouldn't
  // happen because dependsOn blocks it, but defense-in-depth), the
  // approve must reject loudly. Without this guard, the persisted
  // approvedCall would have `input: undefined` and the downstream op
  // would fire with no input.
  it('rejects approve when actionPreview.inputBindings cannot be resolved (Finding 2)', async () => {
    const payloadStore = { store: mockStore };
    const runWithoutExecuteOutput = {
      ...runWithExecuteOutput,
      tasks: [
        // Execute is "succeeded" but has no outputRef — bindings can't materialize.
        {
          taskId: 'execute',
          status: 'succeeded' as const,
          attempt: 1,
          outputRef: null,
          summary: null,
        },
        {
          taskId: TASK_ID,
          status: 'paused' as const,
          attempt: 1,
          outputRef: null,
          summary: null,
        },
      ],
    };
    const result = await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: runWithoutExecuteOutput as never,
      workflow: workflowWithBindings,
      surfaced,
      output: { decision: 'approved' },
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: payloadStore as never,
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('APPROVED_CALL_RESOLUTION_FAILED');
    }
    // CRITICAL: no payload was stored — the approve was NOT persisted.
    expect(mockStore).not.toHaveBeenCalled();
  });

  it('echoes RESOLVED actionPreview.inputBindings into approvedCall (Finding 3)', async () => {
    const payloadStore = { store: mockStore };
    const result = await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: runWithExecuteOutput as never,
      workflow: workflowWithBindings,
      surfaced,
      output: { decision: 'approved' },
      claimToken: 'claim-1',
      actorUserId: 'user-1',
      payloadStore: payloadStore as never,
      storeContext: {
        tenantId: '00000000-0000-0000-0000-000000000001' as never,
        runId: RUN_ID,
        stepExecutionId: '00000000-0000-0000-0000-000000000002',
        attempt: 1,
      },
    });
    expect(result.ok).toBe(true);
    // The echoed approvedCall must contain the materialized values from
    // execute's output — NOT the raw inputBindings objects. This is the
    // Finding 3 fix: without it, downstream submit op consumes
    // `{ filePath: { kind: 'task_output', ... } }` instead of the path.
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'approved',
          approvedCall: {
            op: 'mcp.tool.call',
            input: {
              filePath: '/tmp/submission.csv',
              message: 'iteration 1 — first attempt',
            },
          },
        }),
      }),
    );
  });
});
