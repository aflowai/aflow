import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { getWriteApprovalGrant } from '@aflow/redis';
import type { ApiWriteApprovalRequestPayload, TenantId } from '@aflow/schemas';

const mockLoadRunById = vi.fn();
const mockClaimResumeLease = vi.fn();
const mockReleaseResumeClaim = vi.fn();
const mockCommitReExecute = vi.fn();
const mockCommitFail = vi.fn();
const mockEmitWorkflowProgress = vi.fn();
const mockEmitRunUpdated = vi.fn();

vi.mock('../ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ledger.js')>();
  return {
    ...actual,
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    claimResumeLease: (...args: unknown[]) => mockClaimResumeLease(...args),
    releaseResumeClaim: (...args: unknown[]) => mockReleaseResumeClaim(...args),
    commitReExecutePausedTaskAndResume: (...args: unknown[]) => mockCommitReExecute(...args),
    commitFailTaskAndResume: (...args: unknown[]) => mockCommitFail(...args),
  };
});

vi.mock('../workflowRunProgress.js', () => ({
  emitWorkflowProgress: (...args: unknown[]) => mockEmitWorkflowProgress(...args),
}));

vi.mock('../runEvents.js', () => ({
  emitRunUpdated: (...args: unknown[]) => mockEmitRunUpdated(...args),
}));

const { readPausedTaskWriteApproval, resolvePausedRunWriteApproval } =
  await import('../pausedRunWriteApproval.js');

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '0013314a-0000-4000-8000-000000000162';
const TASK_ID = 'merge';
const PAYLOAD_REF = 'payload:write-approval';
const OPERATOR = '00000000-0000-0000-0000-0000000000aa';

const MERGE_REQUEST: ApiWriteApprovalRequestPayload = {
  kind: 'write_approval',
  target: 'api',
  apiId: 'github',
  endpointId: 'mergePullRequest',
  endpointName: 'Merge a pull request',
  method: 'PUT',
  urlHost: 'api.github.com',
  writeRiskTier: 'medium',
  bodyPreview: '{"merge_method":"squash","sha":"a392f680"}',
  requestHash: '86b46923aa',
};

function payloadStore(payload: unknown = MERGE_REQUEST) {
  return {
    retrieve: vi.fn((ref: string) =>
      ref === PAYLOAD_REF ? Promise.resolve(payload) : Promise.reject(new Error('missing')),
    ),
  };
}

/** Just the two commands the grant store issues, over a map. */
function grantRedis() {
  const keys = new Map<string, string>();
  return {
    keys,
    set: vi.fn((key: string, value: string) => {
      keys.set(key, value);
      return Promise.resolve('OK');
    }),
    get: (key: string) => Promise.resolve(keys.get(key) ?? null),
  };
}

function pausedRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    spaceId: SPACE_ID,
    workflowSlug: 'local-pr-shepherd',
    status: 'paused',
    pausedReason: 'task_paused',
    pausedPayloadRef: PAYLOAD_REF,
    pauseVersion: 3,
    startedAt: new Date('2026-10-21T09:00:00.000Z'),
    tasks: [
      { taskId: 'read-pr', status: 'succeeded', attempt: 1, outputRef: 'payload:pr' },
      {
        taskId: TASK_ID,
        status: 'paused',
        attempt: 1,
        outputRef: PAYLOAD_REF,
        operationId: 'api.http.call',
      },
    ],
    ...overrides,
  };
}

const hooks = {
  applyFailureMode: vi.fn().mockResolvedValue(undefined),
  dispatchRetriedTask: vi.fn().mockResolvedValue(undefined),
};

function decide(
  decision: 'approved' | 'denied',
  extra: { reason?: string; pauseVersion?: number } = {},
) {
  const redis = grantRedis();
  const store = payloadStore();
  const run = resolvePausedRunWriteApproval(
    { db: {} as never, redis: redis as never, payloadStore: store as never },
    {
      tenantId: TENANT,
      spaceId: SPACE_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      pauseVersion: extra.pauseVersion ?? 3,
      actorUserId: OPERATOR,
      decision,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    },
    hooks,
  );
  return { run, redis };
}

beforeEach(() => {
  configureLogging({ service: 'test', level: 'silent' });
  vi.clearAllMocks();
  mockLoadRunById.mockResolvedValue(pausedRun());
  mockClaimResumeLease.mockResolvedValue({ ok: true, claim: { claimToken: 'tok' } });
  mockReleaseResumeClaim.mockResolvedValue(true);
  mockCommitReExecute.mockResolvedValue('committed');
  mockCommitFail.mockResolvedValue('committed');
  mockEmitWorkflowProgress.mockResolvedValue(undefined);
  mockEmitRunUpdated.mockResolvedValue(undefined);
});

describe('readPausedTaskWriteApproval', () => {
  const run = pausedRun();
  const task = run.tasks[1]!;

  it("reads the request the run's pause holds for the task that raised it", async () => {
    await expect(
      readPausedTaskWriteApproval(payloadStore() as never, run, task),
    ).resolves.toMatchObject({
      requestHash: MERGE_REQUEST.requestHash,
      endpointId: 'mergePullRequest',
    });
  });

  it("reads nothing for a task that does not hold the run's pause", async () => {
    const other = { ...task, outputRef: 'payload:other' };
    await expect(
      readPausedTaskWriteApproval(payloadStore() as never, run, other),
    ).resolves.toBeNull();
  });

  it('reads nothing for any other pause cause', async () => {
    const store = payloadStore();
    await expect(
      readPausedTaskWriteApproval(store as never, { ...run, pausedReason: 'needs_decision' }, task),
    ).resolves.toBeNull();
    expect(store.retrieve).not.toHaveBeenCalled();
  });

  it('reads nothing for a task pause whose payload is not a write approval', async () => {
    const store = payloadStore({ kind: 'approval', title: 'Approve?' });
    await expect(readPausedTaskWriteApproval(store as never, run, task)).resolves.toBeNull();
  });
});

describe('resolvePausedRunWriteApproval — approve', () => {
  it('mints the grant keyed by tenant, run and request, then re-executes the task', async () => {
    const { run, redis } = decide('approved', { reason: 'ship it' });
    await expect(run).resolves.toMatchObject({ ok: true });

    const grant = await getWriteApprovalGrant(
      redis as never,
      TENANT,
      RUN_ID,
      MERGE_REQUEST.requestHash,
    );
    expect(grant).toMatchObject({
      requestHash: MERGE_REQUEST.requestHash,
      decision: 'approved',
      approvedBy: OPERATOR,
      reason: 'ship it',
    });
    expect(mockClaimResumeLease).toHaveBeenCalledWith({}, TENANT, RUN_ID, 3);
    expect(mockCommitReExecute).toHaveBeenCalledWith({}, TENANT, {
      runId: RUN_ID,
      claimToken: 'tok',
      taskId: TASK_ID,
      expectedAttempt: 1,
    });
    // The grant is on record before the task can be dispatched to read it.
    expect(redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      mockCommitReExecute.mock.invocationCallOrder[0]!,
    );
    expect(hooks.dispatchRetriedTask).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN_ID,
      TASK_ID,
    );
    expect(hooks.applyFailureMode).not.toHaveBeenCalled();
    expect(mockCommitFail).not.toHaveBeenCalled();
  });

  it('releases the lease and reports the race when the task moved on', async () => {
    mockCommitReExecute.mockResolvedValueOnce('task_row_not_paused');
    const { run } = decide('approved');
    await expect(run).resolves.toMatchObject({ ok: false, code: 'STALE_PAUSE' });
    expect(mockReleaseResumeClaim).toHaveBeenCalledWith({}, TENANT, RUN_ID, 'tok');
    expect(hooks.dispatchRetriedTask).not.toHaveBeenCalled();
  });
});

describe('resolvePausedRunWriteApproval — deny', () => {
  it("fails the task non-retryable with the operator's reason and lets the run go on", async () => {
    const { run, redis } = decide('denied', { reason: 'not this head' });
    await expect(run).resolves.toMatchObject({ ok: true });

    const grant = await getWriteApprovalGrant(
      redis as never,
      TENANT,
      RUN_ID,
      MERGE_REQUEST.requestHash,
    );
    expect(grant).toMatchObject({ decision: 'denied', reason: 'not this head' });

    expect(mockCommitFail).toHaveBeenCalledTimes(1);
    const failArgs = mockCommitFail.mock.calls[0]![2] as {
      taskId: string;
      attempt: number;
      reason: string;
      error: { code: string; classification: string; retryable: boolean };
    };
    expect(failArgs).toMatchObject({
      runId: RUN_ID,
      claimToken: 'tok',
      taskId: TASK_ID,
      attempt: 1,
    });
    expect(failArgs.reason).toContain('not this head');
    expect(failArgs.error).toEqual({
      code: 'write_approval_denied',
      classification: 'permission',
      retryable: false,
    });
    expect(hooks.applyFailureMode).toHaveBeenCalledWith(expect.anything(), TENANT, RUN_ID, TASK_ID);
    expect(hooks.dispatchRetriedTask).not.toHaveBeenCalled();
    expect(mockCommitReExecute).not.toHaveBeenCalled();
  });

  it("shows the denied task failed on the run's surface", async () => {
    const { run } = decide('denied', { reason: 'not this head' });
    await run;
    const taskUpdates = progressEvents('WorkflowTaskUpdate');
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0]).toMatchObject({
      runId: RUN_ID,
      taskId: TASK_ID,
      status: 'failed',
      attempt: 1,
    });
    expect((taskUpdates[0] as { failureReason: string }).failureReason).toContain('not this head');
  });
});

/** The payloads of every progress event of one kind the resolve emitted, in order. */
function progressEvents(kind: string): unknown[] {
  return mockEmitWorkflowProgress.mock.calls
    .map((call) => (call[1] as { event: { kind: string; payload: unknown } }).event)
    .filter((event) => event.kind === kind)
    .map((event) => event.payload);
}

describe('resolvePausedRunWriteApproval — the run surface', () => {
  it.each([
    ['approved', () => hooks.dispatchRetriedTask],
    ['denied', () => hooks.applyFailureMode],
  ] as const)(
    'moves the run surface from paused to running when the write is %s',
    async (decision, handOff) => {
      const { run } = decide(decision);
      await expect(run).resolves.toMatchObject({ ok: true });

      const runUpdates = progressEvents('WorkflowRunUpdate');
      expect(runUpdates).toEqual([
        expect.objectContaining({
          runId: RUN_ID,
          slug: 'local-pr-shepherd',
          status: 'running',
          pauseVersion: 3,
        }),
      ]);
      expect(mockEmitRunUpdated).toHaveBeenCalledWith(expect.anything(), {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        runId: RUN_ID,
        workflowSlug: 'local-pr-shepherd',
        status: 'running',
      });
      // Before the harness gets the run, which may take it terminal and say so itself.
      const handedOff = handOff().mock.invocationCallOrder[0]!;
      const surfaceUpdate = mockEmitWorkflowProgress.mock.calls.findIndex(
        (call) => (call[1] as { event: { kind: string } }).event.kind === 'WorkflowRunUpdate',
      );
      expect(mockEmitWorkflowProgress.mock.invocationCallOrder[surfaceUpdate]).toBeLessThan(
        handedOff,
      );
      expect(mockEmitRunUpdated.mock.invocationCallOrder[0]).toBeLessThan(handedOff);
    },
  );

  it.each([
    ['approved', () => mockCommitReExecute.mockResolvedValueOnce('claim_lost')],
    ['denied', () => mockCommitFail.mockResolvedValueOnce('claim_lost')],
  ] as const)(
    'says nothing on the surface when a %s answer does not land',
    async (decision, lose) => {
      lose();
      const { run } = decide(decision);
      await expect(run).resolves.toMatchObject({ ok: false, code: 'RESUME_COMMIT_LOST' });
      expect(mockEmitWorkflowProgress).not.toHaveBeenCalled();
      expect(mockEmitRunUpdated).not.toHaveBeenCalled();
    },
  );
});

describe('resolvePausedRunWriteApproval — refusals', () => {
  it('answers nothing for a pause the operator did not see', async () => {
    const { run, redis } = decide('approved', { pauseVersion: 2 });
    await expect(run).resolves.toMatchObject({ ok: false, code: 'STALE_PAUSE' });
    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    expect(redis.keys.size).toBe(0);
  });

  it('answers nothing once the run is no longer paused on a write approval', async () => {
    mockLoadRunById.mockResolvedValueOnce(pausedRun({ pausedReason: 'manual' }));
    const { run, redis } = decide('approved');
    await expect(run).resolves.toMatchObject({ ok: false, code: 'STALE_PAUSE' });
    expect(redis.keys.size).toBe(0);
  });

  it('mints no grant when another answer holds the resume lease', async () => {
    mockClaimResumeLease.mockResolvedValueOnce({ ok: false, code: 'RESUME_IN_PROGRESS' });
    const { run, redis } = decide('approved');
    await expect(run).resolves.toMatchObject({ ok: false, code: 'RESUME_IN_PROGRESS' });
    expect(redis.keys.size).toBe(0);
    expect(mockCommitReExecute).not.toHaveBeenCalled();
  });

  it('leaves the run paused when the grant cannot be written', async () => {
    const redis = grantRedis();
    redis.set.mockImplementationOnce(() => Promise.reject(new Error('redis down')));
    const result = await resolvePausedRunWriteApproval(
      { db: {} as never, redis: redis as never, payloadStore: payloadStore() as never },
      {
        tenantId: TENANT,
        spaceId: SPACE_ID,
        runId: RUN_ID,
        taskId: TASK_ID,
        pauseVersion: 3,
        actorUserId: OPERATOR,
        decision: 'approved',
      },
      hooks,
    );
    expect(result).toMatchObject({ ok: false, code: 'GRANT_NOT_WRITTEN' });
    expect(mockReleaseResumeClaim).toHaveBeenCalledWith({}, TENANT, RUN_ID, 'tok');
    expect(mockCommitReExecute).not.toHaveBeenCalled();
    expect(hooks.dispatchRetriedTask).not.toHaveBeenCalled();
  });
});
