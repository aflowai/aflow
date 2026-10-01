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

  it('prefers client-supplied approvedCall over echo', async () => {
    const payloadStore = { store: mockStore };
    const clientCall = { op: 'kaggle.submit', input: { path: '/edited.csv' } };
    await applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow,
      surfaced,
      output: { decision: 'approved', approvedCall: clientCall },
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
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedCall: clientCall }),
      }),
    );
  });
});

describe('applyHumanReplaceOutputResolution — the boundary records the approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBump.mockResolvedValue(1);
    mockCommitReplace.mockResolvedValue('committed');
    mockStore.mockResolvedValue('payload:output-1');
  });

  function resolve(output: unknown, recordApproval?: (call: unknown) => Promise<void>) {
    return applyHumanReplaceOutputResolution({
      db: {} as never,
      tenantIdStr: 'tenant',
      run: run as never,
      workflow,
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

  it('hands it the approved call before the approval is stored or committed', async () => {
    const recordApproval = vi.fn(() => Promise.resolve());
    const result = await resolve({ decision: 'approved' }, recordApproval);
    expect(result.ok).toBe(true);
    expect(recordApproval).toHaveBeenCalledWith({
      op: 'kaggle.submit',
      input: { path: '/tmp/sub.csv' },
    });
    const recorded = recordApproval.mock.invocationCallOrder[0] ?? Infinity;
    expect(recorded).toBeLessThan(mockStore.mock.invocationCallOrder[0] ?? -1);
    expect(recorded).toBeLessThan(mockCommitReplace.mock.invocationCallOrder[0] ?? -1);
  });

  it('commits nothing when recording fails, and records nothing for an invalid approval', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('redis down')));
    await expect(resolve({ decision: 'approved' }, failing)).rejects.toThrow('redis down');
    expect(mockCommitReplace).not.toHaveBeenCalled();

    const recordApproval = vi.fn(() => Promise.resolve());
    const invalid = await resolve({ decision: 'rejected' }, recordApproval);
    expect(invalid.ok).toBe(false);
    expect(recordApproval).not.toHaveBeenCalled();
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
