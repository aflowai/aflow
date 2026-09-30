/**
 * WorkflowRunHarness — Phase 2.1 unit tests.
 *
 * Drives `onWorkflowTaskComplete` and `notifyWaiters` against mocked
 * ledger / Redis / PayloadStore deps. Focused on the correctness
 * scenarios surfaced by Phase 2.1's review:
 *
 *   - Duplicate delivery on already-terminal row re-drives the
 *     post-record decision (succeeded → dispatchNextOrTerminate;
 *     failed → applyFailureMode; paused → notifyWaiters only, NOT
 *     re-pause).
 *   - Stale attempt / cancelled mid-flight drop without record.
 *   - notifyWaiters' synthetic StepResultMessage carries a
 *     non-empty `traceId` so addStepResult schema parse succeeds.
 *
 * Phase 2.3 adds end-to-end integration tests against real DB +
 * Redis. These unit tests only exercise the decision graph.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { TenantId } from '@aflow/schemas';
import type { HarnessDeps } from '../WorkflowRunHarness.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockListTaskRows = vi.fn();
const mockClearCompletionPending = vi.fn();
const mockCasCompleteTask = vi.fn();
const mockClaimAndSchedule = vi.fn();
const mockReserveTaskSlots = vi.fn();
const mockRecordTaskSkipped = vi.fn();
const mockLoadPendingWaiters = vi.fn();
const mockMarkWaiterNotified = vi.fn();
const mockRehydrateParkedStep = vi.fn();
const mockAddWaiter = vi.fn();
const mockAddAttentionItem = vi.fn();
const mockBlockDescendantTasks = vi.fn();
const mockCancelNonTerminalTasksForRun = vi.fn();
const mockListCompletionPendingForRun = vi.fn();
const mockClearAllCompletionPendingForRun = vi.fn();
const mockListDueCompletionPending = vi.fn();
const mockBumpCompletionPendingDueAt = vi.fn();
const mockAddCompletionPending = vi.fn();
const mockRecoverOrphanedTaskAttempt = vi.fn();
const mockComputeReadyTasksWithWhen = vi.fn();
const mockComputeDescendants = vi.fn();
const mockLoadRunById = vi.fn();
const mockLedgerCompleteRun = vi.fn();
const mockLedgerPauseRun = vi.fn();

const mockClaimHumanTask = vi.fn();
const mockLedgerRecordTaskResult = vi.fn();

const mockSurfaceWorkflowResumeContractWaiter = vi.fn().mockResolvedValue(null);

vi.mock('@aflow/cybernetic-runtime', async () => ({
  // Cleanup is no longer swallowed, so an absent export here fails the run
  // rather than hiding — which is how this mock went unnoticed.
  discardTaskDraft: vi.fn(async () => true),
  materializeSkillTasks: (
    await vi.importActual<typeof import('@aflow/cybernetic-runtime')>('@aflow/cybernetic-runtime')
  ).materializeSkillTasks,
  materializeAndValidateSkillConfig: (
    await vi.importActual<typeof import('@aflow/cybernetic-runtime')>('@aflow/cybernetic-runtime')
  ).materializeAndValidateSkillConfig,
  buildResumeContract: (input: { runId: string; taskId?: string; pauseCause: string }) => ({
    pauseCause: input.pauseCause,
    resumePrompt: 'stub',
    ...(input.taskId ? { failedTaskId: input.taskId } : {}),
    allowedResumeModes: ['re_execute', 'fail'],
    suggestedResumeCall: {
      op: 'workflow.run.resume',
      args: { runId: input.runId, resolution: { mode: 're_execute' } },
    },
  }),
  storeWorkflowResumeContract: vi.fn().mockResolvedValue('inline:wrapped='),
  resolvePausedContractRef: vi.fn(
    async (args: {
      contractRef: string;
      payloadStore: { retrieve: (ref: string) => Promise<unknown> };
    }) => {
      try {
        const payload = await args.payloadStore.retrieve(args.contractRef);
        if (
          payload &&
          typeof payload === 'object' &&
          'pauseCause' in payload &&
          typeof (payload as { pauseCause: unknown }).pauseCause === 'string'
        ) {
          return {
            contractRef: args.contractRef,
            pauseReason: (payload as { pauseCause: string }).pauseCause,
          };
        }
      } catch {
        return null;
      }
      return { contractRef: 'inline:wrapped=', pauseReason: 'subagent_handoff' };
    },
  ),
  surfaceWorkflowResumeContract: (...args: unknown[]) =>
    mockSurfaceWorkflowResumeContractWaiter(...args),
  listTaskRows: (...args: unknown[]) => mockListTaskRows(...args),
  // Reads through the same fixture as the list so one staged set of task rows
  // drives both readers.
  getTaskRow: async (db: unknown, tenantId: unknown, runId: unknown, taskId: unknown) => {
    const rows = (await mockListTaskRows(db, tenantId, runId)) as
      Array<{ taskId: string }> | undefined;
    return rows?.find((row) => row.taskId === taskId) ?? null;
  },
  clearCompletionPending: (...args: unknown[]) => mockClearCompletionPending(...args),
  casCompleteTask: (...args: unknown[]) => mockCasCompleteTask(...args),
  claimAndSchedule: (...args: unknown[]) => mockClaimAndSchedule(...args),
  claimHumanTask: (...args: unknown[]) => mockClaimHumanTask(...args),
  // Grants every ready task a slot — the slot arithmetic and its serialization
  // are covered in the runtime package, and forcing every harness fixture to
  // stage a run row would only test the stub.
  reserveTaskSlots: (...args: unknown[]) => mockReserveTaskSlots(...args),
  recordTaskResult: (...args: unknown[]) => mockLedgerRecordTaskResult(...args),
  recordTaskSkipped: (...args: unknown[]) => mockRecordTaskSkipped(...args),
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  markWaiterNotified: (...args: unknown[]) => mockMarkWaiterNotified(...args),
  rehydrateParkedStep: (...args: unknown[]) => mockRehydrateParkedStep(...args),
  addWaiter: (...args: unknown[]) => mockAddWaiter(...args),
  addAttentionItem: (...args: unknown[]) => mockAddAttentionItem(...args),
  blockDescendantTasks: (...args: unknown[]) => mockBlockDescendantTasks(...args),
  cancelNonTerminalTasksForRun: (...args: unknown[]) => mockCancelNonTerminalTasksForRun(...args),
  listCompletionPendingForRun: (...args: unknown[]) => mockListCompletionPendingForRun(...args),
  clearAllCompletionPendingForRun: (...args: unknown[]) =>
    mockClearAllCompletionPendingForRun(...args),
  listDueCompletionPending: (...args: unknown[]) => mockListDueCompletionPending(...args),
  bumpCompletionPendingDueAt: (...args: unknown[]) => mockBumpCompletionPendingDueAt(...args),
  addCompletionPending: (...args: unknown[]) => mockAddCompletionPending(...args),
  recoverOrphanedTaskAttempt: (...args: unknown[]) => mockRecoverOrphanedTaskAttempt(...args),
  computeReadyTasksWithWhen: (...args: unknown[]) => mockComputeReadyTasksWithWhen(...args),
  computeDescendants: (...args: unknown[]) => mockComputeDescendants(...args),
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  completeRun: (...args: unknown[]) => mockLedgerCompleteRun(...args),
  pauseRun: (...args: unknown[]) => mockLedgerPauseRun(...args),
  emitRunUpdated: vi.fn().mockResolvedValue(undefined),
  buildHumanTaskHydrationFields: () => undefined,
  resolveActionPreview: (preview: unknown) => ({ ok: true, preview }),
  runContextFromDetail: async () => ({ taskOutputs: new Map(), stateVariables: new Map() }),
  buildDurableHydration: (args: unknown) => args,
  encodeInlineHydrationRef: () => 'inline:stub=',
  loadWorkflowHumanTaskHydration: async () => ({
    kind: 'missing',
    diagnostic: {
      code: 'WORKFLOW_HUMAN_TASK_HYDRATION_MISSING',
      runId: '',
      taskId: '',
      attempt: 1,
      pauseVersion: 0,
      message: 'test stub',
    },
  }),
  loadTaskOutputs: async () => new Map(),
  collectOutputReferencedTaskIds: () => new Set<string>(),
  emitWorkflowProgress: async (
    _deps: unknown,
    args: { tenantId: string; runId: string; event: { kind: string; payload: unknown } },
  ) => {
    const waiters = (await mockLoadPendingWaiters(null, args.tenantId, args.runId)) as Array<{
      waiterSessionId: string;
    }>;
    for (const w of waiters ?? []) {
      await mockAppendSessionEvent(null, args.tenantId, w.waiterSessionId, {
        eventId: 'mock-evt',
        eventType: args.event.kind,
        timestamp: 0,
        sessionId: w.waiterSessionId,
        ...(args.event.kind === 'WorkflowRunUpdate'
          ? { workflowRunUpdate: args.event.payload }
          : { workflowTaskUpdate: args.event.payload }),
      });
    }
  },
}));

// `buildTaskInputRef` / `buildDelegateTaskInput` live in taskHelpers.ts
// and depend on heavy upstream resolvers (delegation context, runner
// model, derived schemas). Stub at the module level so dispatchTask
// paths don't pull the whole helper into these unit tests.
const mockBuildTaskInputRef = vi.fn();
const mockBuildDelegateTaskInput = vi.fn();
vi.mock('../taskHelpers.js', () => ({
  buildTaskInputRef: (...args: unknown[]) => mockBuildTaskInputRef(...args),
  buildDelegateTaskInput: (...args: unknown[]) => mockBuildDelegateTaskInput(...args),
}));

const mockDispatchInlineOp = vi.fn();
vi.mock('../../SessionOrchestrator/handlers/dispatchInlineOp.js', () => ({
  dispatchInlineOp: (...args: unknown[]) => mockDispatchInlineOp(...args),
}));

const mockGetStepState = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetStepInFlight = vi.fn();
// An executor that never registered the step: the sweeper's pre-existing view.
mockGetStepInFlight.mockResolvedValue({ alive: false, deadlineAtMs: null });
const mockSetSessionState = vi.fn();
const mockUpdateStepState = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockAddStepResult = vi.fn();
const mockAddStepJob = vi.fn();
const mockAddControlMessage = vi.fn();
// The cascade publishes a step abort alongside the control message — that is
// what reaches an operation task, which has no Runner session to address.
const mockPublishStepAbort = vi.fn();
/** The durable half of the cascade — an executor that missed the publish reads this. */
const mockMarkStepCancelled = vi.fn().mockResolvedValue(undefined);
const mockGetRunAccessGrant = vi.fn();

vi.mock('@aflow/redis', () => ({
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getStepInFlight: (...args: unknown[]) => mockGetStepInFlight(...args),
  readSpaceContextGen: () => Promise.resolve(0),
  setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
  getRunAccessGrant: (...args: unknown[]) => mockGetRunAccessGrant(...args),
  serializeRunAccessGrant: (grant: unknown) => JSON.stringify(grant),
  updateStepState: (...args: unknown[]) => mockUpdateStepState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  publishStepAbort: (...args: unknown[]) => mockPublishStepAbort(...args),
  markStepCancelled: (...args: unknown[]) => mockMarkStepCancelled(...args),
}));

const mockResolveWorkflowForRunRevision = vi.fn();
class MockMissingPinnedRevisionError extends Error {}

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    resolveWorkflowForRunRevision: (...args: unknown[]) =>
      mockResolveWorkflowForRunRevision(...args),
    MissingPinnedRevisionError: MockMissingPinnedRevisionError,
    // loadRunByRunIdAcrossSpaces in the harness lazy-imports
    // workflowRuns + createTenantContext + withTenantSchema. Provide
    // pass-through that yields the spaceId we set on the run row.
    workflowRuns: actual.workflowRuns,
    createTenantContext: actual.createTenantContext,
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ spaceId: 'space-1' }]) }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      }),
    ),
  };
});

// Now import the module under test (after vi.mock).
const {
  onWorkflowTaskComplete,
  notifyWaiters,
  dispatchTask,
  spawnRunnerSession,
  startRun,
  routeRunnerTerminalToHarness,
  PostClaimDispatchError,
  cancelRun,
  reconcileStaleRunForTenant,
  resolveWorkflowForRun,
} = await import('../WorkflowRunHarness.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Real UUIDs — `createTenantContext` validates UUID format on
// the harness's loadRunByRunIdAcrossSpaces helper.
const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = '00000000-0000-0000-0000-0000000000a1';
const TASK_ID = 'task-a';

const deps: HarnessDeps = {
  db: {} as never,
  redis: {} as never,
  payloadStore: {
    store: vi.fn().mockResolvedValue('inline:e30='),
    shouldStore: (data: unknown) =>
      Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_INLINE_PAYLOAD_BYTES,
  } as never,
};

function buildTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    status: 'running',
    attempt: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    outputRef: null,
    summary: null,
    metricsJson: null,
    sessionId: null,
    workerSessionId: null,
    ...overrides,
  };
}

function buildRunDetail(taskRows: unknown[], status: string = 'running') {
  return {
    runId: RUN_ID,
    spaceId: 'space-1',
    workflowSlug: 'test-skill',
    workflowRevision: 1,
    status,
    sessionId: null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 0,
    resumeAttemptCount: 0,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: null,
    tasks: taskRows,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing durable to restore from, so a cold waiter stays cold
  // unless a test stages a snapshot.
  mockRehydrateParkedStep.mockResolvedValue(false);
  // Default: the pause lands, taking the run's first pause version.
  mockLedgerPauseRun.mockResolvedValue(1);
  // Default: every ready task gets a slot. The arithmetic and its serialization
  // are covered in the runtime package; tests that care about the throttle
  // override this to return a partial reservation.
  mockReserveTaskSlots.mockImplementation(
    (_db: unknown, _tenantId: unknown, params: { readyTaskIds: string[] }) => ({
      reserved: [...params.readyTaskIds],
      deferred: [],
      limit: params.readyTaskIds.length,
      activeCount: 0,
    }),
  );
  // Default: buildTaskInputRef returns a deterministic inline ref and
  // buildDelegateTaskInput a minimal valid delegate input, so dispatch
  // paths can proceed. Tests that need to assert on the resolved input
  // override per-call.
  mockBuildTaskInputRef.mockResolvedValue('inline:e30=');
  mockBuildDelegateTaskInput.mockResolvedValue({
    agentId: 'cybernetic-runner',
    input: 'do',
    config: {},
    displayMeta: { workflowSlug: 'test-skill', taskId: TASK_ID, taskName: 'Task A' },
  });
  // Default: skip-loop's reload returns no rows. Tests that need
  // intermediate skip rows override per-call.
  mockListTaskRows.mockResolvedValue([]);
  mockComputeDescendants.mockReturnValue(new Set<string>());
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('onWorkflowTaskComplete', () => {
  describe('idempotency guards', () => {
    it('drops stale attempt without recording', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ attempt: 2 })]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockCasCompleteTask).not.toHaveBeenCalled();
      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('drops cancelled-mid-flight without recording', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'cancelled' })]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockCasCompleteTask).not.toHaveBeenCalled();
      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('drops missing task row entirely', async () => {
      mockListTaskRows.mockResolvedValueOnce([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockCasCompleteTask).not.toHaveBeenCalled();
      expect(mockClearCompletionPending).not.toHaveBeenCalled();
    });
  });

  describe('duplicate delivery — already-terminal row re-drives', () => {
    it('succeeded duplicate re-drives dispatchNextOrTerminate (no double-write)', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'succeeded' })]);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'succeeded' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [{ taskId: TASK_ID, name: 'Task A', goal: 'do thing', optional: false }],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      // Critical: did NOT re-write the row (CAS would have caught it
      // anyway, but we should skip the call entirely on duplicate).
      expect(mockCasCompleteTask).not.toHaveBeenCalled();

      // Re-drive: dispatchNextOrTerminate was invoked → loadRunById +
      // computeReadyTasksWithWhen + completeRun (no ready tasks, all
      // required terminal) all fired.
      expect(mockResolveWorkflowForRunRevision).toHaveBeenCalled();
      expect(mockComputeReadyTasksWithWhen).toHaveBeenCalled();
      expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
      expect(mockLedgerCompleteRun.mock.calls[0]?.[2]).toMatchObject({ status: 'completed' });

      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('failed duplicate re-drives applyFailureMode (no double-write)', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'failed' })]);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'failed' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [{ taskId: TASK_ID, name: 'Task A', goal: 'do thing', optional: false }],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'failed', failureReason: 'boom' },
      });

      expect(mockCasCompleteTask).not.toHaveBeenCalled();

      // applyFailureMode fired → cancel_siblings (default) → completeRun(failed).
      expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
      expect(mockLedgerCompleteRun.mock.calls[0]?.[2]).toMatchObject({ status: 'failed' });

      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('paused duplicate notifies waiters only — does NOT re-pause the run', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'paused' })]);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused'),
      );
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'paused', contractRef: 'inline:contract=' },
      });

      // Critical: NO re-pause (would bump pauseVersion incorrectly).
      expect(mockLedgerPauseRun).not.toHaveBeenCalled();
      expect(mockCasCompleteTask).not.toHaveBeenCalled();

      // Just notifyWaiters — markWaiterNotified is the proxy signal.
      expect(mockLoadPendingWaiters).toHaveBeenCalled();
      // No waiters in this fixture so notifyWaiters short-circuits;
      // we assert the load happened (the entry point fired).

      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('paused result on an OPERATOR (manual) pause does NOT wake waiters (Plan 182 §2.6)', async () => {
      // A late result from a Runner the operator interrupted lands on the
      // operator-set `paused` task row. The run's `pausedReason:'manual'` keeps
      // the parent Helmsman parked until an explicit resume, so re-driving
      // notifyWaiters would wake it with a spurious `paused` outcome. The late
      // result must drop without notifying — `loadPendingWaiters` (the
      // notifyWaiters entry point) is never reached, even with a waiter present.
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'paused' })]);
      mockLoadRunById.mockResolvedValue({
        ...buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused'),
        pausedReason: 'manual',
      });
      mockLoadPendingWaiters.mockResolvedValue([
        {
          id: 'waiter-manual',
          runId: RUN_ID,
          waiterSessionId: 'sess-manual',
          waiterStepExecutionId: 'step-manual',
          notifiedAt: null,
          notifiedOutcome: null,
        },
      ]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'paused', contractRef: 'inline:contract=' },
      });

      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
      expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
      expect(mockLedgerPauseRun).not.toHaveBeenCalled();
    });

    it('paused duplicate redrive carries pausedPayloadRef from refreshed run row', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'paused' })]);
      const beforeCommit = buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused');
      const afterCommit = {
        ...buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused'),
        pausedPayloadRef: 'inline:contract-ref=',
      };
      mockLoadRunById.mockResolvedValueOnce(beforeCommit).mockResolvedValueOnce(afterCommit);

      // Provide one pending waiter so notifyWaiters reaches addStepResult.
      mockLoadPendingWaiters.mockResolvedValue([
        {
          id: 'waiter-redrive',
          runId: RUN_ID,
          waiterSessionId: 'sess-redrive',
          waiterStepExecutionId: 'step-redrive',
          notifiedAt: null,
          notifiedOutcome: null,
        },
      ]);
      mockGetStepState.mockResolvedValueOnce({
        stepId: 'workflow-run-start',
        stepType: 'workflow',
        operationId: 'workflow.run.start',
        status: 'PAUSED',
        attempt: 1,
        inputRef: 'inline:in=',
      });

      // Capture the payloadStore.store envelope so we can assert the
      // redrive wakeup carries the contract ref.
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const localDeps: HarnessDeps = {
        db: deps.db,
        redis: deps.redis,
        payloadStore: { store: storeMock } as never,
      };

      await onWorkflowTaskComplete(localDeps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'paused', contractRef: 'inline:incoming=' },
      });

      expect(mockLedgerPauseRun).not.toHaveBeenCalled();
      expect(mockLoadRunById).toHaveBeenCalledTimes(2);
      expect(storeMock).toHaveBeenCalledOnce();
      const storeArg = storeMock.mock.calls[0]?.[0] as {
        data: { outcome: string; payloadRef?: string };
      };
      expect(storeArg.data.outcome).toBe('paused');
      expect(storeArg.data.payloadRef).toBe('inline:contract-ref=');
    });

    it('paused duplicate on a run that has since resumed wakes no waiter', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'paused' })]);
      mockLoadRunById
        .mockResolvedValueOnce(buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused'))
        .mockResolvedValueOnce(buildRunDetail([buildTaskRow({ status: 'paused' })], 'running'));

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'paused', contractRef: 'inline:incoming=' },
      });

      expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
    });
  });

  describe('first delivery — not-yet-terminal row writes outcome', () => {
    it('first succeeded writes via CAS then drives forward', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'running' })]);
      mockCasCompleteTask.mockResolvedValueOnce(true);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'succeeded' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [{ taskId: TASK_ID, name: 'Task A', goal: 'do thing', optional: false }],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockCasCompleteTask).toHaveBeenCalledOnce();
      expect(mockCasCompleteTask.mock.calls[0]?.[2]).toMatchObject({
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        status: 'succeeded',
        outputRef: 'inline:abc=',
      });
      expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    });

    it('first failed delivery — structured AflowError metadata + failedAt flow to CAS write', async () => {
      mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'running' })]);
      mockCasCompleteTask.mockResolvedValueOnce(true);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'failed' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [{ taskId: TASK_ID, name: 'Task A', goal: 'do thing', optional: false }],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: {
          kind: 'failed',
          errorRef: 'inline:err=',
          failureReason: 'Alpaca returned HTTP 400',
          errorCode: 'EGRESS_HTTP_400',
          errorClassification: 'external_dependency',
          errorRetryable: false,
        },
      });

      expect(mockCasCompleteTask).toHaveBeenCalledOnce();
      const params = mockCasCompleteTask.mock.calls[0]?.[2] as {
        runId: string;
        status: string;
        failureReason: string;
        errorCode: string;
        errorClassification: string;
        errorRetryable: boolean;
        failedAt: Date;
      };
      expect(params.status).toBe('failed');
      expect(params.failureReason).toBe('Alpaca returned HTTP 400');
      expect(params.errorCode).toBe('EGRESS_HTTP_400');
      expect(params.errorClassification).toBe('external_dependency');
      expect(params.errorRetryable).toBe(false);
      // failedAt is stamped to the completion timestamp by recordTaskOutcome.
      expect(params.failedAt).toBeInstanceOf(Date);
    });
  });

  describe('completion against required tasks', () => {
    it('does NOT complete the run when a required task has no row yet', async () => {
      // Row for task-a (succeeded), workflow declares task-a + task-b
      // both required. Row for task-b doesn't exist yet — completion
      // should wait, not fire `completed`.
      mockListTaskRows.mockResolvedValueOnce([
        buildTaskRow({ taskId: TASK_ID, status: 'succeeded' }),
      ]);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ taskId: TASK_ID, status: 'succeeded' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [
            { taskId: TASK_ID, name: 'A', goal: 'a', optional: false },
            { taskId: 'task-b', name: 'B', goal: 'b', optional: false },
          ],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      // task-b has no row — required-not-terminal. completeRun must
      // NOT have fired.
      expect(mockLedgerCompleteRun).not.toHaveBeenCalled();
    });
  });

  describe('CAS miss — reload and re-drive from persisted status', () => {
    it('CAS miss with persisted status=cancelled drops without driving forward', async () => {
      // Pre-check sees row at 'running'. CAS misses (returns false) —
      // reload finds row at 'cancelled' (concurrent cancel won the race).
      // Handler must drop without dispatchNextOrTerminate /
      // applyFailureMode, since the cancel path drives its own state.
      mockListTaskRows
        .mockResolvedValueOnce([buildTaskRow({ status: 'running' })])
        .mockResolvedValueOnce([buildTaskRow({ status: 'cancelled' })]);
      mockCasCompleteTask.mockResolvedValueOnce(false);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'cancelled' })], 'running'),
      );

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      // CAS attempted but missed. Cancellation path drives its own
      // state — we must NOT dispatch forward / complete the run.
      expect(mockCasCompleteTask).toHaveBeenCalledOnce();
      expect(mockLedgerCompleteRun).not.toHaveBeenCalled();
      // clearCompletionPending also NOT called — the row is now under
      // the cancel path's authority. (The cancel path is responsible
      // for its own pending cleanup.)
      expect(mockClearCompletionPending).not.toHaveBeenCalled();
    });

    it('CAS miss with persisted status=succeeded re-drives dispatchNextOrTerminate', async () => {
      // Two-delivery race: pre-check sees 'running'. CAS misses (a
      // concurrent path wrote 'succeeded' first). Reload finds
      // 'succeeded'. Handler re-drives the post-record path from the
      // persisted status — completeRun (single-task workflow).
      mockListTaskRows
        .mockResolvedValueOnce([buildTaskRow({ status: 'running' })])
        .mockResolvedValueOnce([buildTaskRow({ status: 'succeeded' })]);
      mockCasCompleteTask.mockResolvedValueOnce(false);
      mockLoadRunById.mockResolvedValue(
        buildRunDetail([buildTaskRow({ status: 'succeeded' })], 'running'),
      );
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [{ taskId: TASK_ID, name: 'Task A', goal: 'do thing', optional: false }],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
      mockLoadPendingWaiters.mockResolvedValue([]);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockCasCompleteTask).toHaveBeenCalledOnce();
      // Re-drive triggered: completeRun fires from persisted state.
      expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
      expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    });

    it('CAS miss with attempt drift drops without driving', async () => {
      mockListTaskRows
        .mockResolvedValueOnce([buildTaskRow({ status: 'running', attempt: 1 })])
        .mockResolvedValueOnce([buildTaskRow({ status: 'running', attempt: 2 })]);
      mockCasCompleteTask.mockResolvedValueOnce(false);

      await onWorkflowTaskComplete(deps, {
        tenantId: TENANT,
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
      });

      expect(mockLedgerCompleteRun).not.toHaveBeenCalled();
      expect(mockClearCompletionPending).not.toHaveBeenCalled();
    });
  });

  describe('ready-set filtering against existing rows', () => {
    it('does NOT dispatch a task that already has a running row', async () => {
      // Workflow has task-a (just succeeded — triggering this call) +
      // task-b (already running — has row, should NOT be dispatched
      // again on this completion).
      const taskA = buildTaskRow({ taskId: TASK_ID, status: 'succeeded' });
      const taskB = buildTaskRow({ taskId: 'task-b', status: 'running' });
      mockListTaskRows.mockResolvedValueOnce([taskA, taskB]);
      mockLoadRunById.mockResolvedValue(buildRunDetail([taskA, taskB], 'running'));
      mockResolveWorkflowForRunRevision.mockResolvedValue({
        workflow: {
          tasks: [
            { taskId: TASK_ID, name: 'A', goal: 'a', optional: false },
            { taskId: 'task-b', name: 'B', goal: 'b', optional: false },
          ],
          slug: 'test-skill',
        },
        source: 'revision',
      });
      // Graph helper returns task-b as "ready" (its deps are satisfied
      // — task-a succeeded). Without the harness's `tasksWithRows`
      // filter, dispatchTask would be called for task-b even though
      // it's in flight.
      mockComputeReadyTasksWithWhen.mockReturnValue({
        ready: [{ taskId: 'task-b', name: 'B', goal: 'b' }],
        skipped: [],
        errors: [],
      });

      // The handler will treat the (already-succeeded) task-a as a
      // duplicate-redrive path → call dispatchNextOrTerminate, which
      // would try to dispatch task-b. The ready-set filter must
      // exclude it because task-b already has a row. Phase 2.1's
      // dispatchTask is a stub that throws — so if filtering misses,
      // we'd see a thrown error here.
      await expect(
        onWorkflowTaskComplete(deps, {
          tenantId: TENANT,
          workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
          outcome: { kind: 'succeeded', outputRef: 'inline:abc=' },
        }),
      ).resolves.not.toThrow();

      // No dispatch fired (task-b filtered) and no completion fired
      // (task-b not yet terminal).
      expect(mockLedgerCompleteRun).not.toHaveBeenCalled();
    });
  });
});

describe('notifyWaiters', () => {
  it('writes a synthetic StepResultMessage with non-empty traceId', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-1',
        runId: RUN_ID,
        waiterSessionId: 'sess-1',
        waiterStepExecutionId: 'step-1',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      // No traceId — fall back to deterministic per-waiter id.
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'completed',
    });

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const synthetic = mockAddStepResult.mock.calls[0]?.[1] as { traceId: string };
    expect(synthetic.traceId.length).toBeGreaterThan(0);
    expect(synthetic.traceId).toBe('notify-waiter:waiter-1');
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
  });

  it('uses the waiter session traceId when present', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-2',
        runId: RUN_ID,
        waiterSessionId: 'sess-2',
        waiterStepExecutionId: 'step-2',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'real-trace-abc',
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'paused',
    });

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const synthetic = mockAddStepResult.mock.calls[0]?.[1] as { traceId: string };
    expect(synthetic.traceId).toBe('real-trace-abc');
  });

  it('rehydrates a waiter whose hot state aged out, then wakes it', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-cold',
        runId: RUN_ID,
        waiterSessionId: 'sess-cold',
        waiterStepExecutionId: 'step-cold',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    // Cold on the first read; the snapshot restores it for the second.
    mockGetStepState.mockResolvedValueOnce(null).mockResolvedValueOnce({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'trace-cold',
    });
    mockRehydrateParkedStep.mockResolvedValueOnce(true);

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'paused',
    });

    expect(mockRehydrateParkedStep).toHaveBeenCalledOnce();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const synthetic = mockAddStepResult.mock.calls[0]?.[1] as { traceId: string };
    expect(synthetic.traceId).toBe('trace-cold');
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
  });

  it('drops the waiter only when rehydration cannot recover the step state', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-3',
        runId: RUN_ID,
        waiterSessionId: 'sess-3',
        waiterStepExecutionId: 'step-3',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue(null);

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'cancelled',
    });

    expect(mockRehydrateParkedStep).toHaveBeenCalledOnce();
    expect(mockAddStepResult).not.toHaveBeenCalled();
    // Nothing a retry reaches, so the row is stamped rather than left pending.
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
  });

  it('leaves the waiter pending when rehydration fails transiently', async () => {
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-4',
        runId: RUN_ID,
        waiterSessionId: 'sess-4',
        waiterStepExecutionId: 'step-4',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue(null);
    mockRehydrateParkedStep.mockRejectedValueOnce(new Error('postgres unavailable'));

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'paused',
    });

    expect(mockAddStepResult).not.toHaveBeenCalled();
    // Unstamped, so the next run transition tries this waiter again.
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
  });

  it('Plan 135 §4.2 — emits WorkflowRunUpdate BEFORE the synthetic step result', async () => {
    // Surface-fan-out ordering invariant: the chat reducer must see the
    // run-terminal WorkflowRunUpdate event (which freezes the surface card)
    // before the synthetic step result wakes the Helmsman waiter (which
    // unblocks the next assistant turn). Otherwise the surface card stays
    // mid-render while the assistant has already moved on.
    //
    // loadPendingWaiters is called twice — once by notifyWaiters' top-level
    // load, once by emitWorkflowProgress (called from emitTerminalRunUpdate).
    // Use mockResolvedValue (persistent) so both calls return the waiter.
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-ordering',
        runId: RUN_ID,
        waiterSessionId: 'sess-ordering',
        waiterStepExecutionId: 'step-ordering',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    });
    // Pre-loaded run detail so emitTerminalRunUpdate doesn't reload.
    const preloadedRun = buildRunDetail([], 'completed');

    // Capture call order across the two emission paths.
    const callOrder: string[] = [];
    mockAppendSessionEvent.mockImplementation((...args: unknown[]) => {
      const ev = args[3] as { eventType: string };
      callOrder.push(`appendSessionEvent:${ev.eventType}`);
      return Promise.resolve('msg-id');
    });
    mockAddStepResult.mockImplementation(() => {
      callOrder.push('addStepResult');
      return Promise.resolve();
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'completed',
      runDetail: preloadedRun,
    });

    // First event: WorkflowRunUpdate (from emitTerminalRunUpdate).
    // Then per-waiter: SessionResumed event + synthetic addStepResult.
    expect(callOrder[0]).toBe('appendSessionEvent:WorkflowRunUpdate');
    expect(callOrder).toContain('addStepResult');
    const runUpdateIdx = callOrder.indexOf('appendSessionEvent:WorkflowRunUpdate');
    const stepResultIdx = callOrder.indexOf('addStepResult');
    expect(runUpdateIdx).toBeLessThan(stepResultIdx);
  });

  it('Plan 135 §4.2 review fix — excludeSessionIds skips listed sessions in wakeup loop AND mark-notified', async () => {
    // The handoff path uses this to avoid waking the just-added resume
    // waiter. Without the exclusion, notifyWaiters would loadPendingWaiters
    // (which includes the new waiter), wake all of them with 'handed_off',
    // and mark them notified — pulling the rug out from under the very
    // Helmsman that just took over the run.
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-old',
        runId: RUN_ID,
        waiterSessionId: 'sess-old',
        waiterStepExecutionId: 'step-old',
        notifiedAt: null,
        notifiedOutcome: null,
      },
      {
        id: 'waiter-new',
        runId: RUN_ID,
        waiterSessionId: 'sess-new',
        waiterStepExecutionId: 'step-new',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'handed_off',
      handoffPayload: { resumedBy: 'sess-new', nextStep: 'released_do_not_poll' },
      excludeSessionIds: ['sess-new'],
    });

    // Synthetic step result + markWaiterNotified fire ONLY for the old waiter.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const target = (mockAddStepResult.mock.calls[0]![1] as { sessionId: string }).sessionId;
    expect(target).toBe('sess-old');
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
    const notifiedWaiterId = (mockMarkWaiterNotified.mock.calls[0]![2] as { waiterId: string })
      .waiterId;
    expect(notifiedWaiterId).toBe('waiter-old');
  });

  it('wakes EVERY pending waiter on a terminal outcome (multi-waiter runs)', async () => {
    // A resume without takeOver leaves the original driver's waiter
    // registered alongside the resumer's — both must receive the
    // terminal notification, each keyed on its own waiter row id.
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-original',
        runId: RUN_ID,
        waiterSessionId: 'sess-original',
        waiterStepExecutionId: 'step-original',
        notifiedAt: null,
        notifiedOutcome: null,
      },
      {
        id: 'waiter-resumer',
        runId: RUN_ID,
        waiterSessionId: 'sess-resumer',
        waiterStepExecutionId: 'step-resumer',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'completed',
    });

    expect(mockAddStepResult).toHaveBeenCalledTimes(2);
    const wokenSessions = mockAddStepResult.mock.calls.map(
      (c) => (c[1] as { sessionId: string }).sessionId,
    );
    expect(wokenSessions.sort()).toEqual(['sess-original', 'sess-resumer']);
    const wokenKeys = mockAddStepResult.mock.calls.map(
      (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(wokenKeys.sort()).toEqual([
      'notify-waiter:waiter-original:completed',
      'notify-waiter:waiter-resumer:completed',
    ]);
    expect(mockMarkWaiterNotified).toHaveBeenCalledTimes(2);
  });

  it('Plan 135 §4.2 — handed_off outcome does NOT emit WorkflowRunUpdate (waiter-only event)', async () => {
    // `handed_off` means a takeover resume released this waiter; the
    // run-level state is unchanged, so no `WorkflowRunUpdate` should fire.
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-handoff',
        runId: RUN_ID,
        waiterSessionId: 'sess-handoff',
        waiterStepExecutionId: 'step-handoff',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'handed_off',
      handoffPayload: { resumedBy: 'other-helmsman', nextStep: 'released_do_not_poll' },
    });

    const eventTypes = mockAppendSessionEvent.mock.calls.map(
      (c) => (c[3] as { eventType: string }).eventType,
    );
    expect(eventTypes).not.toContain('WorkflowRunUpdate');
    // SessionResumed (waiter wakeup) still emitted as before.
    expect(eventTypes).toContain('SessionResumed');
  });

  // ─── Pause-context enrichment ───────────────────────────────────────────
  // With a bare wake envelope (`{ runId, outcome, waiterId,
  // payloadRef?, handoffPayload? }`), paused outcomes force
  // Helmsman to fetch + parse the contract to know which task paused
  // and why — a harness-driven concern expressed via prompt rules.
  // `buildWaiterOutputRef` instead decodes the contract at `payloadRef` and
  // inlines a `pause` block carrying taskId, pauseCause, and a one-line
  // reason. Tests below pin both the happy path and the best-effort
  // degradation when the contract is missing / malformed.
  describe('wake envelope — pause-context enrichment', () => {
    const waiter = {
      id: 'waiter-pause-ctx',
      runId: RUN_ID,
      waiterSessionId: 'sess-pause-ctx',
      waiterStepExecutionId: 'step-pause-ctx',
      notifiedAt: null,
      notifiedOutcome: null,
    };
    const stepState = {
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    };

    function buildLocalDeps(
      contractData: unknown,
      storeMock: ReturnType<typeof vi.fn>,
    ): HarnessDeps {
      const retrieveMock = vi.fn().mockResolvedValue(contractData);
      return {
        db: deps.db,
        redis: deps.redis,
        payloadStore: { store: storeMock, retrieve: retrieveMock } as never,
      };
    }

    it('inlines pause.taskId + pause.pauseCause + pause.reason for a HITL pause', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const contract = {
        pauseCause: 'needs_decision',
        failedTaskId: 'approve-submit',
        decisionPrompt: 'Approve the Kaggle submission below.',
        resumePrompt: 'fallback prompt — should be outranked',
      };

      await notifyWaiters(buildLocalDeps(contract, storeMock), {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const envelope = storeMock.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(envelope.data['outcome']).toBe('paused');
      expect(envelope.data['payloadRef']).toBe('inline:contract=');
      const pause = envelope.data['pause'] as Record<string, unknown>;
      expect(pause).toBeDefined();
      expect(pause['taskId']).toBe('approve-submit');
      expect(pause['pauseCause']).toBe('needs_decision');
      expect(pause['reason']).toBe('Approve the Kaggle submission below.');
    });

    it('prefers handoffPayload.reason over resumePrompt for signal_blocked pauses', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const contract = {
        pauseCause: 'subagent_handoff',
        failedTaskId: 'submit-call',
        handoffPayload: {
          reason: 'PUT to GCS failed: HTTP method PUT is not allowed.',
        },
        resumePrompt: 'fallback prompt',
      };

      await notifyWaiters(buildLocalDeps(contract, storeMock), {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const pause = (storeMock.mock.calls[0]?.[0] as { data: { pause: Record<string, unknown> } })
        .data.pause;
      expect(pause['taskId']).toBe('submit-call');
      expect(pause['pauseCause']).toBe('subagent_handoff');
      expect(pause['reason']).toBe('PUT to GCS failed: HTTP method PUT is not allowed.');
    });

    it('falls back to resumePrompt when no specific reason field is present', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const contract = {
        pauseCause: 'manual',
        failedTaskId: 'some-task',
        resumePrompt: 'Operator paused manually.',
      };

      await notifyWaiters(buildLocalDeps(contract, storeMock), {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const pause = (storeMock.mock.calls[0]?.[0] as { data: { pause: Record<string, unknown> } })
        .data.pause;
      expect(pause['reason']).toBe('Operator paused manually.');
    });

    it('omits pause block when no payloadRef is provided (older callers)', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');

      await notifyWaiters(
        // No retrieve needed — outcome is paused but no payloadRef.
        { ...deps, payloadStore: { store: storeMock } as never },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          outcome: 'paused',
        },
      );

      const data = (storeMock.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data['pause']).toBeUndefined();
    });

    it('omits pause block when the contract decode fails (best-effort)', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const retrieveMock = vi.fn().mockRejectedValue(new Error('payload gone'));
      const localDeps: HarnessDeps = {
        db: deps.db,
        redis: deps.redis,
        payloadStore: { store: storeMock, retrieve: retrieveMock } as never,
      };

      await notifyWaiters(localDeps, {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const data = (storeMock.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data['pause']).toBeUndefined();
      // The wake itself still happens — degradation is silent, not blocking.
      expect(mockAddStepResult).toHaveBeenCalledOnce();
    });

    it('Plan 171 §2.2.5 — inlines pause contract fields via surfaceWorkflowResumeContract', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const contract = {
        pauseCause: 'subagent_handoff',
        failedTaskId: 'submit-call',
        handoffPayload: {
          reason: 'Kaggle MCP unreachable',
          blockingCategory: 'external_dependency',
        },
        resumePrompt: 'External dependency timeout — retry once Kaggle MCP is up.',
      };

      // Mock surfaceWorkflowResumeContract via the cybernetic-runtime mock
      // — the harness mock's surfaceWorkflowResumeContract surfaces this
      // shape with the live pauseVersion stamped on suggestedResumeCall.
      mockSurfaceWorkflowResumeContractWaiter.mockResolvedValueOnce({
        contract: {
          ...contract,
          allowedResumeModes: ['re_execute', 'fail'] as const,
          suggestedResumeCall: {
            op: 'workflow.run.resume' as const,
            args: {
              runId: RUN_ID,
              pauseVersion: 42, // live version injected
              resolution: { mode: 're_execute' as const },
            },
          },
          pausedTaskInputContract: {
            schema: {
              type: 'object',
              required: ['remediationConfirmed'],
              properties: { remediationConfirmed: { type: 'boolean', const: true } },
            },
            resolutionMode: 're_execute' as const,
            prompt: 'Confirm remediation, then add remediationConfirmed: true.',
          },
        },
        pauseVersion: 42,
        pausedReason: 'task_paused',
        resumeAttemptCount: 0,
      });

      await notifyWaiters(buildLocalDeps(contract, storeMock), {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const pause = (storeMock.mock.calls[0]?.[0] as { data: { pause: Record<string, unknown> } })
        .data.pause;
      // Existing fields still populated.
      expect(pause['taskId']).toBe('submit-call');
      expect(pause['pauseCause']).toBe('subagent_handoff');
      expect(pause['allowedResumeModes']).toEqual(['re_execute', 'fail']);
      const suggested = pause['suggestedResumeCall'] as Record<string, unknown>;
      expect(suggested['op']).toBe('workflow.run.resume');
      const args = suggested['args'] as Record<string, unknown>;
      // Live pauseVersion is present — Helmsman copies the call verbatim.
      expect(args['pauseVersion']).toBe(42);
      const resolution = args['resolution'] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
      const inputContract = pause['pausedTaskInputContract'] as {
        schema: Record<string, unknown>;
        resolutionMode: string;
      };
      expect(inputContract.resolutionMode).toBe('re_execute');
      expect(inputContract.schema['required']).toContain('remediationConfirmed');
    });

    it('omits pause.suggestedResumeCall when surfaceWorkflowResumeContract returns null (graceful degradation)', async () => {
      // surface helper fails → pause block still includes taskId /
      // pauseCause / reason but omits allowedResumeModes,
      // suggestedResumeCall, and pausedTaskInputContract. Helmsman falls
      // back to workflow.run.detail.
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const contract = {
        pauseCause: 'subagent_handoff',
        failedTaskId: 'submit-call',
        resumePrompt: 'Stale contract — surface helper returns null.',
      };
      mockSurfaceWorkflowResumeContractWaiter.mockResolvedValueOnce(null);

      await notifyWaiters(buildLocalDeps(contract, storeMock), {
        tenantId: TENANT,
        runId: RUN_ID,
        outcome: 'paused',
        payloadRef: 'inline:contract=',
      });

      const pause = (storeMock.mock.calls[0]?.[0] as { data: { pause: Record<string, unknown> } })
        .data.pause;
      expect(pause['taskId']).toBe('submit-call');
      expect(pause['pauseCause']).toBe('subagent_handoff');
      expect(pause['allowedResumeModes']).toBeUndefined();
      expect(pause['suggestedResumeCall']).toBeUndefined();
      expect(pause['pausedTaskInputContract']).toBeUndefined();
    });

    it('omits pause block for non-paused outcomes (terminal wakeups unchanged)', async () => {
      mockLoadPendingWaiters.mockResolvedValueOnce([waiter]);
      mockGetStepState.mockResolvedValueOnce(stepState);
      const storeMock = vi.fn().mockResolvedValue('inline:wake=');
      const retrieveMock = vi.fn(); // should never be called

      await notifyWaiters(
        {
          ...deps,
          payloadStore: { store: storeMock, retrieve: retrieveMock } as never,
        },
        {
          tenantId: TENANT,
          runId: RUN_ID,
          outcome: 'completed',
          payloadRef: 'inline:final-output=',
        },
      );

      const data = (storeMock.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
      expect(data['pause']).toBeUndefined();
      expect(retrieveMock).not.toHaveBeenCalled();
    });
  });
});

// ─── dispatchTask — Phase 2.2 dispatch primitive ─────────────────────────────

describe('dispatchTask', () => {
  const HELMSMAN_SESSION = '11111111-1111-1111-1111-111111111111';

  function mockSingleTaskWorkflow(taskId: string, overrides: Record<string, unknown> = {}): void {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [
          {
            taskId,
            name: 'Task A',
            goal: 'do thing',
            optional: false,
            ...overrides,
          },
        ],
      },
      source: 'revision',
    });
  }

  it('agent task: encodes Runner-shaped { input, config } + stamps structured fields', async () => {
    mockSingleTaskWorkflow(TASK_ID, { agent: 'cybernetic-runner' });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({
      createdBy: 'user-abc',
      actorContextJson: undefined,
    });
    // buildDelegateTaskInput returns the delegate input as a value.
    // Only { input, config } may reach the Runner's start_run
    // (processFlowInput only handles that shape at top level); the rest
    // is stamped onto structured QUEUED-state fields.
    const delegateInput = {
      agentId: 'cybernetic-runner',
      input: 'do the thing',
      config: { runner_model: 'sonnet', runner_tools: [] },
      context: { objective: 'demo' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      validatorRefs: ['compose.task-graph-draft', 'task-graph-self-consistent'],
      displayMeta: { workflowSlug: 'test-skill', taskId: TASK_ID, taskName: 'Task A' },
    };
    mockBuildDelegateTaskInput.mockResolvedValueOnce(delegateInput);

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    const claimArgs = mockClaimAndSchedule.mock.calls[0]?.[2] as {
      sessionId?: string;
      inputRef: string;
    };

    // Critical: the input ref the Runner receives is { input, config }
    // — NOT the full delegate input. processFlowInput rejects the
    // envelope shape, so a full-envelope path would fail Runner start.
    const runnerInput = JSON.parse(
      Buffer.from(claimArgs.inputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(runnerInput).toEqual({
      input: 'do the thing',
      config: { runner_model: 'sonnet', runner_tools: [] },
    });

    // Structured fields stamped onto QUEUED Runner state — the
    // QUEUED→RUNNING preserve carries them forward so the Runner's
    // delegation context, output schema, and display metadata work.
    expect(mockSetSessionState).toHaveBeenCalledOnce();
    const queued = mockSetSessionState.mock.calls[0]?.[1] as {
      delegationContextJson?: string;
      finalOutputSchemaOverrideJson?: string;
      finalOutputValidatorRefs?: string[];
      delegationDisplayWorkflowSlug?: string;
      delegationDisplayTaskId?: string;
      delegationDisplayTaskName?: string;
      workflowExecution?: unknown;
    };
    expect(queued.delegationContextJson).toBe(JSON.stringify({ objective: 'demo' }));
    expect(queued.finalOutputSchemaOverrideJson).toBe(JSON.stringify(delegateInput.outputSchema));
    // Plan 206: validatorRefs must survive delegate input → QUEUED state,
    // or the in-session submit_output check never runs (the silent-drop bug).
    expect(queued.finalOutputValidatorRefs).toEqual([
      'compose.task-graph-draft',
      'task-graph-self-consistent',
    ]);
    expect(queued.delegationDisplayWorkflowSlug).toBe('test-skill');
    expect(queued.delegationDisplayTaskId).toBe(TASK_ID);
    expect(queued.delegationDisplayTaskName).toBe('Task A');
    expect(queued.workflowExecution).toEqual({
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
    });

    // start_run command points at the pre-allocated workerSessionId.
    const ctrl = mockAddControlMessage.mock.calls[0]?.[1] as {
      type: string;
      runId: string;
    };
    expect(ctrl.type).toBe('start_run');
    expect(ctrl.runId).toBe(claimArgs.sessionId);
  });

  it('agent task: oversized Runner input spills once, as { input, config } only', async () => {
    mockSingleTaskWorkflow(TASK_ID, { agent: 'cybernetic-runner' });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({});
    const bigInput = 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1024);
    mockBuildDelegateTaskInput.mockResolvedValueOnce({
      agentId: 'cybernetic-runner',
      input: bigInput,
      config: { runner_model: 'sonnet' },
      displayMeta: { workflowSlug: 'test-skill', taskId: TASK_ID, taskName: 'Task A' },
    });
    const storedRef = 'gs://test-bucket/runs/r/input.json';
    const store = vi.fn().mockResolvedValue(storedRef);

    await dispatchTask(
      { ...deps, payloadStore: { store } as never },
      {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      },
    );

    // Exactly one stored payload — the Runner's { input, config } — and
    // the claim carries its ref. The delegate input itself is never
    // stored (a stored envelope would be read back once and orphaned).
    expect(store).toHaveBeenCalledOnce();
    expect((store.mock.calls[0]?.[0] as { data: unknown }).data).toEqual({
      input: bigInput,
      config: { runner_model: 'sonnet' },
    });
    const claimArgs = mockClaimAndSchedule.mock.calls[0]?.[2] as { inputRef: string };
    expect(claimArgs.inputRef).toBe(storedRef);
  });

  it('operation task: claims row, enqueues StepJobMessage with workflowExecution + no sessionId', async () => {
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'ai.text.generate',
      inputs: { prompt: 'hello' },
    });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({ createdBy: 'user-xyz' });

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    expect(mockAddStepJob).toHaveBeenCalledOnce();
    const job = mockAddStepJob.mock.calls[0]?.[1] as {
      sessionId?: string;
      workflowExecution?: { runId: string; taskId: string; attempt: number };
      operationId: string;
      stepType: string;
      credentialOwnerId?: string;
    };
    // Schema invariant: workflowExecution set, sessionId absent.
    expect(job.workflowExecution).toEqual({
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN_ID}:${TASK_ID}:1`,
    });
    expect(job.sessionId).toBeUndefined();
    expect(job.operationId).toBe('ai.text.generate');
    expect(job.stepType).toBe('ai');
    expect(job.credentialOwnerId).toBe('user-xyz');

    // No Runner spawn for operation tasks.
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('inline operation task: claims row, runs dispatchInlineOp with workflowExecution, no addStepJob', async () => {
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'skill.compose.prepare_surface',
      inputs: {},
    });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({});

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    // Inline path: dispatchInlineOp ran with workflowExecution set
    // (typed correlation; helpers route StepResultMessage with
    // `workflowExecution`, no `sessionId`).
    expect(mockDispatchInlineOp).toHaveBeenCalledOnce();
    const call = mockDispatchInlineOp.mock.calls[0];
    expect(call).toBeDefined();
    const stepDef = call?.[3] as { operation: string; stepType: string };
    expect(stepDef.operation).toBe('skill.compose.prepare_surface');
    expect(stepDef.stepType).toBe('skill');
    const workflowExecution = call?.[10] as {
      runId: string;
      taskId: string;
      attempt: number;
      dispatchAttemptToken: string;
    };
    expect(workflowExecution).toEqual({
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN_ID}:${TASK_ID}:1`,
    });
    // Inline path bypasses the executor stream entirely.
    expect(mockAddStepJob).not.toHaveBeenCalled();
  });

  it('inline operation task: handler throw triggers post-claim failure + PostClaimDispatchError', async () => {
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'skill.compose.prepare_surface',
      inputs: {},
    });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({});
    mockDispatchInlineOp.mockRejectedValueOnce(new Error('redis SET refused'));
    mockCasCompleteTask.mockResolvedValueOnce(true);

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toBeInstanceOf(PostClaimDispatchError);

    // Post-claim failure ran: row CAS'd to failed, pending cleared.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as { status: string };
    expect(casArgs.status).toBe('failed');
    expect(mockClearCompletionPending).toHaveBeenCalledOnce();
  });

  it('inline operation task: rejects unsafe inline op before claiming the row', async () => {
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'agent.control.delegate',
      inputs: {},
    });
    mockGetSessionState.mockResolvedValue({});

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toThrow(/not on the workflow-task safelist/);

    // Pre-claim: nothing happened on the row.
    expect(mockClaimAndSchedule).not.toHaveBeenCalled();
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();
  });

  it('human task: pauses with full WorkflowResumeContract (replace_output)', async () => {
    mockSingleTaskWorkflow(TASK_ID, {
      pauseInstruction: 'Approve the deployment?',
      outputContract: {
        schema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
          required: ['approved'],
        },
      },
    });
    mockClaimHumanTask.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-human',
        runId: RUN_ID,
        waiterSessionId: 'sess-human',
        waiterStepExecutionId: 'step-human',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
    });
    mockGetSessionState.mockResolvedValue({});

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    // Human path uses dedicated claimHumanTask — NOT claimAndSchedule.
    expect(mockClaimHumanTask).toHaveBeenCalledOnce();
    expect(mockClaimAndSchedule).not.toHaveBeenCalled();
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();

    // Run-side pause sequence ran with the full contract as
    // payloadRef. surfaceWorkflowResumeContract requires the
    // structured shape — { prompt } alone wouldn't surface to
    // workflow.run.detail or render in Helmsman.
    expect(mockLedgerPauseRun).toHaveBeenCalledOnce();
    const pauseArgs = mockLedgerPauseRun.mock.calls[0]?.[3] as {
      reason?: string;
      payloadRef?: string;
    };
    expect(pauseArgs.reason).toBe('task_paused');
    expect(pauseArgs.payloadRef).toMatch(/^inline:/);

    const contract = JSON.parse(
      Buffer.from(pauseArgs.payloadRef!.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(contract.pauseCause).toBe('needs_decision');
    expect(contract.allowedResumeModes).toEqual(['replace_output']);
    expect(contract.allowedResumeModes).not.toContain('re_execute');
    expect(contract.resumePrompt).toBe('Approve the deployment?');
    // task.outputContract.schema flows through as both
    // `replaceOutputSchema` and `expectedTaskOutputSchema`.
    expect(contract.replaceOutputSchema).toEqual({
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    });
    expect(contract.failedTaskId).toBe(TASK_ID);
    // Suggested resume call is the workflow.run.resume(replace_output)
    // shape — surfaceWorkflowResumeContract injects pauseVersion later.
    const suggested = contract.suggestedResumeCall as {
      op: string;
      args: { runId: string; resolution: { mode: string } };
    };
    expect(suggested.op).toBe('workflow.run.resume');
    expect(suggested.args.runId).toBe(RUN_ID);
    expect(suggested.args.resolution.mode).toBe('replace_output');

    const inputContract = contract['pausedTaskInputContract'] as {
      schema: Record<string, unknown>;
      resolutionMode: string;
      prompt: string;
    };
    expect(inputContract).toBeDefined();
    expect(inputContract.resolutionMode).toBe('replace_output');
    expect(inputContract.schema).toEqual({
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    });
    expect(inputContract.prompt).toBe('Approve the deployment?');

    const pausedTaskUpdates = mockAppendSessionEvent.mock.calls
      .map((c) => c[3] as { eventType: string; workflowTaskUpdate?: { status: string } })
      .filter(
        (e) => e.eventType === 'WorkflowTaskUpdate' && e.workflowTaskUpdate?.status === 'paused',
      );
    expect(pausedTaskUpdates.length).toBeGreaterThanOrEqual(1);

    // From Helmsman's POV, a workflow paused
    // on a HITL human task is still running. The waiter MUST stay parked
    // (no synthetic StepResultMessage, no markWaiterNotified) so
    // Helmsman wakes naturally on workflow termination with the full
    // outcome. Without this, Helmsman ends its turn mid-flight at the
    // pause and never sees post-approve task outcomes (e.g., a failing
    // submit-call).
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
  });

  it('human task without outputContract.schema: uses permissive default replaceOutputSchema', async () => {
    // Workflows that don't declare a schema for the human's output
    // still need a valid replaceOutputSchema so the resume CAS can
    // validate the patch against something — fall back to "any object".
    mockSingleTaskWorkflow(TASK_ID, {
      pauseInstruction: 'Provide feedback',
    });
    mockClaimHumanTask.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([]);
    mockGetSessionState.mockResolvedValue({});

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    const pauseArgs = mockLedgerPauseRun.mock.calls[0]?.[3] as { payloadRef?: string };
    const contract = JSON.parse(
      Buffer.from(pauseArgs.payloadRef!.slice('inline:'.length), 'base64').toString('utf8'),
    ) as { replaceOutputSchema: Record<string, unknown> };
    expect(contract.replaceOutputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('invariant: throws when run row is missing (no silent return)', async () => {
    // dispatchTask used to log+return on invariant failures, leaving
    // startRun to push the taskId into activeTasks because the await
    // didn't throw — silent hang. Now invariant failures throw so
    // startRun's failure-collection path catches them and drives the
    // run to terminal via applyFailureMode.
    mockLoadRunById.mockResolvedValueOnce(null);

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toThrow(/workflow run not found/);
  });

  it('invariant: throws when workflow definition is unresolvable', async () => {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    // resolveWorkflowForRunRevision throws (or returns nothing) →
    // resolveWorkflowForRun returns null.
    mockResolveWorkflowForRunRevision.mockRejectedValueOnce(
      new MockMissingPinnedRevisionError('not found'),
    );

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toThrow(/workflow definition not resolvable/);
  });

  it('invariant: throws when task is not in workflow definition', async () => {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        // Workflow has different task ids — TASK_ID is not declared.
        tasks: [{ taskId: 'other-task', name: 'O', goal: 'o', optional: false, agent: 'r' }],
      },
      source: 'revision',
    });

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toThrow(/not present in workflow/);
  });

  it('claim-lost: skips dispatch when another scheduling pass already claimed', async () => {
    mockSingleTaskWorkflow(TASK_ID, { agent: 'cybernetic-runner' });
    mockClaimAndSchedule.mockResolvedValueOnce(false); // already claimed

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    // Claim was attempted but missed — no spawn, no enqueue.
    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockAddStepJob).not.toHaveBeenCalled();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('operation post-claim: addStepJob throws → CAS to failed + clearPending + PostClaimDispatchError', async () => {
    // Operation path. claimAndSchedule lands; addStepJob throws (e.g.,
    // Redis connection lost). dispatchTask must CAS the row to 'failed'
    // (preserving claim metadata) and clear completion_pending, then
    // throw PostClaimDispatchError so the caller skips the legacy
    // upsert that would NULL worker_session_id.
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'ai.text.generate',
      inputs: { prompt: 'hi' },
    });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({ createdBy: 'user-xyz' });
    mockAddStepJob.mockRejectedValueOnce(new Error('redis ECONNRESET'));
    mockCasCompleteTask.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-postclaim',
        runId: RUN_ID,
        waiterSessionId: 'sess-postclaim',
        waiterStepExecutionId: 'step-postclaim',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);

    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toBeInstanceOf(PostClaimDispatchError);

    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    expect(mockAddStepJob).toHaveBeenCalledOnce();

    // CAS-cleanup: row → 'failed' with the original failure reason.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as {
      runId: string;
      taskId: string;
      attempt: number;
      status: string;
      failureReason?: string;
    };
    expect(casArgs).toMatchObject({
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      status: 'failed',
    });
    expect(casArgs.failureReason).toMatch(/redis ECONNRESET/);

    // completion_pending cleared so the sweeper doesn't re-fire.
    expect(mockClearCompletionPending).toHaveBeenCalledOnce();

    const failedTaskUpdates = mockAppendSessionEvent.mock.calls
      .map((c) => c[3] as { eventType: string; workflowTaskUpdate?: { status: string } })
      .filter(
        (e) => e.eventType === 'WorkflowTaskUpdate' && e.workflowTaskUpdate?.status === 'failed',
      );
    expect(failedTaskUpdates.length).toBeGreaterThanOrEqual(1);
    const failedEvent = failedTaskUpdates[0]!;
    expect(failedEvent.workflowTaskUpdate?.status).toBe('failed');
  });

  it('agent post-claim: spawn throws → CAS to failed + clearPending + PostClaimDispatchError', async () => {
    // Agent path. claimAndSchedule lands; spawnRunnerSession throws
    // (e.g., setSessionState rejects). dispatchTask must do the same
    // post-claim cleanup as the operation path so the row reflects the
    // failure with claim metadata preserved.
    mockSingleTaskWorkflow(TASK_ID, { agent: 'cybernetic-runner' });
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({
      createdBy: 'user-abc',
      actorContextJson: undefined,
    });
    // setSessionState (called inside spawnRunnerSession) throws.
    mockSetSessionState.mockRejectedValueOnce(new Error('redis SET refused'));
    mockCasCompleteTask.mockResolvedValueOnce(true);

    // Pre-claim work shouldn't fail: the beforeEach default provides a
    // valid delegate input.
    await expect(
      dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      }),
    ).rejects.toBeInstanceOf(PostClaimDispatchError);

    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    expect(mockSetSessionState).toHaveBeenCalledOnce();

    // CAS-cleanup ran.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as {
      status: string;
      failureReason?: string;
    };
    expect(casArgs.status).toBe('failed');
    expect(casArgs.failureReason).toMatch(/SET refused/);

    expect(mockClearCompletionPending).toHaveBeenCalledOnce();
  });

  it('pre-claim failure (input-resolution throws BEFORE claim) is NOT PostClaimDispatchError', async () => {
    // Sanity: pre-claim failures (e.g., buildTaskInputRef throws,
    // workflow not resolvable) must NOT be PostClaimDispatchError, so
    // dispatchAllOrCollectFailures still routes them through the
    // legacy upsert path (no claim metadata to preserve).
    mockSingleTaskWorkflow(TASK_ID, {
      operation: 'ai.text.generate',
      inputs: { prompt: 'hi' },
    });
    mockBuildTaskInputRef.mockRejectedValueOnce(new Error('input resolution failed'));

    let caughtErr: unknown;
    try {
      await dispatchTask(deps, {
        tenantId: TENANT,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        helmsmanSessionId: HELMSMAN_SESSION as never,
      });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr).not.toBeInstanceOf(PostClaimDispatchError);

    // No claim, no CAS-cleanup, no completion_pending clear.
    expect(mockClaimAndSchedule).not.toHaveBeenCalled();
    expect(mockCasCompleteTask).not.toHaveBeenCalled();
    expect(mockClearCompletionPending).not.toHaveBeenCalled();
  });
});

// ─── spawnRunnerSession — Runner session creation ────────────────────────────

describe('spawnRunnerSession', () => {
  const HELMSMAN_SESSION = '22222222-2222-2222-2222-222222222222';
  const WORKER_SESSION = '33333333-3333-3333-3333-333333333333';

  it('writes QUEUED session hot state with workflowExecution + no parentSessionId', async () => {
    mockGetSessionState.mockResolvedValueOnce({
      createdBy: 'user-q',
      spaceId: 'space-1',
    });

    await spawnRunnerSession(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      workerSessionId: WORKER_SESSION as never,
      helmsmanSessionId: HELMSMAN_SESSION as never,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      inputRef: 'inline:e30=' as never,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-spawn' as never,
    });

    expect(mockSetSessionState).toHaveBeenCalledOnce();
    const queued = mockSetSessionState.mock.calls[0]?.[1] as {
      sessionId: string;
      status: string;
      workflowExecution?: { runId: string; taskId: string; attempt: number };
      parentSessionId?: string;
      agentRoleOverride?: string;
      createdBy?: string;
    };
    expect(queued.sessionId).toBe(WORKER_SESSION);
    expect(queued.status).toBe('QUEUED');
    expect(queued.workflowExecution).toEqual({
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
    });
    // Critical: NO cascade parent — Helmsman observes via waiter row.
    expect(queued.parentSessionId).toBeUndefined();
    expect(queued.agentRoleOverride).toBe('subagent');
    expect(queued.createdBy).toBe('user-q');

    // start_run command enqueued
    expect(mockAddControlMessage).toHaveBeenCalledOnce();
  });

  it('inherits actorContextJson from Helmsman when present', async () => {
    const actorContextJson = JSON.stringify({
      principal: { kind: 'user', userId: HELMSMAN_SESSION },
    });
    mockGetSessionState.mockResolvedValueOnce({
      createdBy: 'user-q',
      actorContextJson,
    });

    await spawnRunnerSession(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      workerSessionId: WORKER_SESSION as never,
      helmsmanSessionId: HELMSMAN_SESSION as never,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      inputRef: 'inline:e30=' as never,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-spawn' as never,
    });

    const queued = mockSetSessionState.mock.calls[0]?.[1] as { actorContextJson?: string };
    expect(queued.actorContextJson).toBe(actorContextJson);
  });

  /**
   * A frozen trial's Runner has no operator authority to compile a grant
   * from, so it inherits the anchor's. That write DELs the hash the grant
   * lives in, so the grant has to be inside it (Plan 28 §P3).
   */
  it("carries the eval anchor's trial grant inside the Runner state write", async () => {
    const trialGrant = { accessLevel: 'read', spaceId: 'space-1' };
    mockGetSessionState.mockResolvedValueOnce({ trigger: 'eval', spaceId: 'space-1' });
    mockGetRunAccessGrant.mockResolvedValueOnce(trialGrant);

    await spawnRunnerSession(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      workerSessionId: WORKER_SESSION as never,
      helmsmanSessionId: HELMSMAN_SESSION as never,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      inputRef: 'inline:e30=' as never,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-eval' as never,
    });

    const queued = mockSetSessionState.mock.calls[0]?.[1] as { grantJson?: string };
    expect(JSON.parse(queued.grantJson!)).toEqual(trialGrant);
  });

  it('an eval anchor with no trial grant leaves the Runner grantless rather than compiling one', async () => {
    mockGetSessionState.mockResolvedValueOnce({ trigger: 'eval', spaceId: 'space-1' });
    mockGetRunAccessGrant.mockResolvedValueOnce(null);

    await spawnRunnerSession(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      workerSessionId: WORKER_SESSION as never,
      helmsmanSessionId: HELMSMAN_SESSION as never,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      inputRef: 'inline:e30=' as never,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-eval' as never,
    });

    const queued = mockSetSessionState.mock.calls[0]?.[1] as { grantJson?: string };
    expect(queued.grantJson).toBeUndefined();
  });

  it('a non-eval spawn never reads a grant to inherit', async () => {
    mockGetSessionState.mockResolvedValueOnce({ createdBy: 'user-q', spaceId: 'space-1' });

    await spawnRunnerSession(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      workerSessionId: WORKER_SESSION as never,
      helmsmanSessionId: HELMSMAN_SESSION as never,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      inputRef: 'inline:e30=' as never,
      agentDefinitionRef: 'cybernetic-runner',
      traceId: 'trace-plain' as never,
    });

    expect(mockGetRunAccessGrant).not.toHaveBeenCalled();
    const queued = mockSetSessionState.mock.calls[0]?.[1] as { grantJson?: string };
    expect(queued.grantJson).toBeUndefined();
  });
});

// ─── startRun — initial dispatch + waiter registration ───────────────────────

describe('startRun', () => {
  const HELMSMAN_SESSION = '44444444-4444-4444-4444-444444444444';
  const HELMSMAN_STEP = '55555555-5555-5555-5555-555555555555';

  it('dispatches first-wave ready tasks; waiter insertion is the caller handler responsibility', async () => {
    const workflow = {
      slug: 'test-skill',
      tasks: [
        { taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' },
        { taskId: 'task-b', name: 'B', goal: 'b', optional: false, dependsOn: ['task-a'] },
      ],
    };
    mockComputeReadyTasksWithWhen.mockReturnValue({
      ready: [workflow.tasks[0]],
      skipped: [],
      errors: [],
    });
    // dispatchTask paths reload run + workflow:
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' });
    mockClaimAndSchedule.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue({});

    const result = await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(mockAddWaiter).not.toHaveBeenCalled();

    // Only task-a dispatched (root), task-b waits on dependency.
    expect(result.activeTasks).toEqual(['task-a']);
  });

  // The reservation's answer must actually gate dispatch. Without this the one
  // line that honours it (`if (!reserved.has(...)) continue`) has no coverage,
  // and a stub that grants everything would keep the suite green.
  it('dispatches only the tasks the reservation granted', async () => {
    const workflow = {
      slug: 'test-skill',
      tasks: [
        { taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' },
        { taskId: 'task-b', name: 'B', goal: 'b', optional: false, agent: 'runner' },
        { taskId: 'task-c', name: 'C', goal: 'c', optional: false, agent: 'runner' },
      ],
    };
    mockComputeReadyTasksWithWhen.mockReturnValue({
      ready: workflow.tasks,
      skipped: [],
      errors: [],
    });
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' });
    mockClaimAndSchedule.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue({});
    mockReserveTaskSlots.mockReturnValue({
      reserved: ['task-a'],
      deferred: ['task-b', 'task-c'],
      limit: 1,
      activeCount: 0,
    });

    const result = await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(result.activeTasks).toEqual(['task-a']);
    const claimedTaskIds = mockClaimAndSchedule.mock.calls.map(
      (call) => (call[2] as { taskId: string }).taskId,
    );
    expect(claimedTaskIds).toEqual(['task-a']);
  });

  it('records skipped tasks via recordTaskSkipped on first wave', async () => {
    const workflow = {
      slug: 'test-skill',
      tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' }],
    };
    // Skip-loop semantics: first call returns the skip; second call
    // (after the skip is recorded) returns an empty set so the loop
    // exits. Without this drain pattern the loop spins forever.
    mockComputeReadyTasksWithWhen
      .mockReturnValueOnce({
        ready: [],
        skipped: [{ task: workflow.tasks[0], reason: 'when-predicate false' }],
        errors: [],
      })
      .mockReturnValueOnce({ ready: [], skipped: [], errors: [] });
    // After the skip is recorded, the skip-loop reloads task rows from
    // DB to recompute readiness with the fresh statuses.
    mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ taskId: 'task-a', status: 'skipped' })]);

    const result = await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(mockRecordTaskSkipped).toHaveBeenCalledOnce();
    expect(result.activeTasks).toEqual([]);
    // All required tasks now resolved (skipped is terminal); run
    // completes via the early-exit branch.
    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
  });

  it('completes the run when first-wave skip-loop drains all required tasks', async () => {
    const workflow = {
      slug: 'test-skill',
      tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' }],
    };
    // Sole required task skips → all-required-terminal → completeRun.
    mockComputeReadyTasksWithWhen
      .mockReturnValueOnce({
        ready: [],
        skipped: [{ task: workflow.tasks[0], reason: 'when false' }],
        errors: [],
      })
      .mockReturnValueOnce({ ready: [], skipped: [], errors: [] });
    mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ taskId: 'task-a', status: 'skipped' })]);

    await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    const completeArgs = mockLedgerCompleteRun.mock.calls[0]?.[2] as { status: string };
    // Skipped is "satisfied" not "failed" — run completes successfully.
    expect(completeArgs.status).toBe('completed');
  });

  it('fails the run when first-wave when-predicate hits an error', async () => {
    const workflow = {
      slug: 'test-skill',
      tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' }],
    };
    mockComputeReadyTasksWithWhen.mockReturnValue({
      ready: [],
      skipped: [],
      errors: [{ task: workflow.tasks[0], reason: 'undefined ref' }],
    });
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockLoadPendingWaiters.mockResolvedValue([]);

    await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    const completeArgs = mockLedgerCompleteRun.mock.calls[0]?.[2] as { status: string };
    expect(completeArgs.status).toBe('failed');
  });

  it('first-wave dispatch failure persists failed task row + fails the run', async () => {
    // Input resolution throws BEFORE the atomic claim — leaves no
    // task row, no completion_pending. Without explicit failure
    // handling, the Helmsman PAUSED step has nothing to wake it.
    const workflow = {
      slug: 'test-skill',
      tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'runner' }],
    };
    mockComputeReadyTasksWithWhen.mockReturnValue({
      ready: [workflow.tasks[0]],
      skipped: [],
      errors: [],
    });
    mockLoadRunById.mockImplementation(async () => {
      const persisted = mockLedgerRecordTaskResult.mock.calls.length > 0;
      return persisted
        ? buildRunDetail([buildTaskRow({ taskId: 'task-a', status: 'failed' })], 'running')
        : buildRunDetail([], 'running');
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' });
    // buildDelegateTaskInput throws — simulates DeriveSchemaError /
    // missing pinned revision / payload-store I/O failure.
    mockBuildDelegateTaskInput.mockRejectedValueOnce(new Error('input resolution failed'));
    mockGetSessionState.mockResolvedValue({});
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    // No task was successfully dispatched.
    expect(result.activeTasks).toEqual([]);
    // Failure persisted as a task row so workflow.run.detail surfaces
    // the error.
    expect(mockLedgerRecordTaskResult).toHaveBeenCalledOnce();
    const recordArgs = mockLedgerRecordTaskResult.mock.calls[0]?.[2] as {
      taskId: string;
      status: string;
      failureReason: string;
    };
    expect(recordArgs.taskId).toBe('task-a');
    expect(recordArgs.status).toBe('failed');
    expect(recordArgs.failureReason).toBe('input resolution failed');
    // Run was failed via applyFailureMode → completeRun.
    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    const completeArgs = mockLedgerCompleteRun.mock.calls[0]?.[2] as { status: string };
    expect(completeArgs.status).toBe('failed');
  });
});

// ─── routeRunnerTerminalToHarness — Runner-terminal adapter ──────────────────

describe('routeRunnerTerminalToHarness', () => {
  it('SUCCEEDED maps to onWorkflowTaskComplete with succeeded outcome', async () => {
    mockListTaskRows.mockResolvedValueOnce([buildTaskRow({ status: 'running' })]);
    mockCasCompleteTask.mockResolvedValueOnce(true);
    mockLoadRunById.mockResolvedValue(buildRunDetail([buildTaskRow({ status: 'succeeded' })]));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: TASK_ID, name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
    mockLoadPendingWaiters.mockResolvedValue([]);

    await routeRunnerTerminalToHarness(
      deps,
      {
        tenantId: TENANT,
        traceId: 'trace-1',
        workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      },
      'SUCCEEDED',
      { outputRef: 'inline:abc=' },
    );

    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as { status: string; outputRef: string };
    expect(casArgs.status).toBe('succeeded');
    expect(casArgs.outputRef).toBe('inline:abc=');
  });

  it('SUCCEEDED without outputRef throws (caller bug)', async () => {
    await expect(
      routeRunnerTerminalToHarness(
        deps,
        {
          tenantId: TENANT,
          workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
        },
        'SUCCEEDED',
        {},
      ),
    ).rejects.toThrow(/missing outputRef/);
  });

  it('throws when called without workflowExecution (caller should guard)', async () => {
    await expect(
      routeRunnerTerminalToHarness(deps, { tenantId: TENANT }, 'SUCCEEDED', {
        outputRef: 'inline:abc=',
      }),
    ).rejects.toThrow(/without workflowExecution/);
  });
});

// ─── End-to-end service-level scenario ──────────────────────────────────────
//
// Phase 2.3 — exercise the full pipeline against mocked boundaries.
// Real-Redis + real-DB integration tests land alongside the Helmsman
// flow updates (Phase 2.5+); for now this scenario verifies that
// startRun → dispatchTask (operation branch) → workflow-task result
// intercept → onWorkflowTaskComplete → completeRun → notifyWaiters
// chain works as a unit, with mocks providing realistic state
// transitions between hops.

describe('end-to-end: operation-task happy path', () => {
  const HELMSMAN_SESSION = '66666666-6666-6666-6666-666666666666';
  const HELMSMAN_STEP = '77777777-7777-7777-7777-777777777777';

  it('startRun → dispatch → result → completeRun → notifyWaiters wakes Helmsman', async () => {
    // Single-task workflow with a single operation task.
    const workflow = {
      slug: 'echo-skill',
      tasks: [
        {
          taskId: 'echo-task',
          name: 'Echo',
          goal: 'Echo the input',
          optional: false,
          operation: 'ai.text.generate',
          inputs: { prompt: 'hello' },
        },
      ],
    };

    // Stage A — startRun.
    //
    // The "task row" lives as a closure state machine; each handler
    // call sees the current snapshot. Transitions:
    //   - Stage A startRun: no row → claim writes 'running'.
    //   - Stage B onWorkflowTaskComplete: 'running' → CAS writes
    //     'succeeded'; dispatchNextOrTerminate reloads and sees the
    //     transition.
    let taskRowState: Record<string, unknown> | null = null;
    const advanceToRunning = () => {
      taskRowState = {
        runId: RUN_ID,
        taskId: 'echo-task',
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
        outputRef: null,
        summary: null,
        metricsJson: null,
        sessionId: null,
        workerSessionId: 'worker-uuid',
      };
    };
    const advanceToSucceeded = (outputRef: string) => {
      taskRowState = { ...(taskRowState ?? {}), status: 'succeeded', outputRef };
    };

    mockComputeReadyTasksWithWhen.mockImplementation(() => {
      // First wave: no rows → ready=task. Post-completion: row
      // succeeded → no rows ready, drives termination.
      if (!taskRowState || taskRowState['status'] === 'running') {
        return { ready: [workflow.tasks[0]], skipped: [], errors: [] };
      }
      return { ready: [], skipped: [], errors: [] };
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' });
    mockClaimAndSchedule.mockImplementation(() => {
      advanceToRunning();
      return Promise.resolve(true);
    });
    mockLoadRunById.mockImplementation(() =>
      Promise.resolve(buildRunDetail(taskRowState ? [taskRowState] : [], 'running')),
    );
    mockListTaskRows.mockImplementation(() => Promise.resolve(taskRowState ? [taskRowState] : []));
    mockGetSessionState.mockResolvedValue({ createdBy: 'user-1' });
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-helmsman',
        runId: RUN_ID,
        waiterSessionId: HELMSMAN_SESSION,
        waiterStepExecutionId: HELMSMAN_STEP,
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'trace-helmsman',
    });
    // CAS state-machine: when called, transition the row to succeeded
    // and report the CAS landed.
    mockCasCompleteTask.mockImplementation((_db: unknown, _tenant: unknown, args: unknown) => {
      const a = args as { status: string; outputRef?: string };
      if (a.status === 'succeeded' && a.outputRef) {
        advanceToSucceeded(a.outputRef);
      }
      return Promise.resolve(true);
    });
    mockLedgerCompleteRun.mockResolvedValue(true);

    const startResult = await startRun(deps, {
      tenantId: TENANT,
      spaceId: 'space-1',
      callingHelmsmanSessionId: HELMSMAN_SESSION as never,
      callingHelmsmanStepExecutionId: HELMSMAN_STEP as never,
      runId: RUN_ID,
      workflow: workflow as never,
    });

    expect(mockAddWaiter).not.toHaveBeenCalled();
    expect(mockAddStepJob).toHaveBeenCalledOnce();
    const enqueuedJob = mockAddStepJob.mock.calls[0]?.[1] as {
      workflowExecution?: { runId: string; taskId: string; attempt: number };
      sessionId?: string;
      operationId: string;
    };
    expect(enqueuedJob.workflowExecution).toMatchObject({
      runId: RUN_ID,
      taskId: 'echo-task',
      attempt: 1,
    });
    expect(enqueuedJob.sessionId).toBeUndefined();
    expect(enqueuedJob.operationId).toBe('ai.text.generate');
    expect(startResult.activeTasks).toEqual(['echo-task']);

    // Reset mock counts (we want to verify post-result behaviour
    // separately from the dispatch behaviour above).
    mockAddStepResult.mockClear();
    mockMarkWaiterNotified.mockClear();
    mockLedgerCompleteRun.mockClear();
    mockCasCompleteTask.mockClear();
    mockClearCompletionPending.mockClear();

    // Stage B — executor returns SUCCEEDED. Simulate the result-consumer
    // intercept by invoking onWorkflowTaskComplete directly with the
    // outcome. The CAS-implementation mock transitions taskRowState
    // from 'running' to 'succeeded' so the subsequent reload sees
    // the new state.

    await onWorkflowTaskComplete(deps, {
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: 'echo-task', attempt: 1 },
      outcome: { kind: 'succeeded', outputRef: 'inline:result=' },
    });

    // CAS landed exactly once with the executor's output ref.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as {
      status: string;
      outputRef: string;
      attempt: number;
    };
    expect(casArgs).toMatchObject({
      status: 'succeeded',
      outputRef: 'inline:result=',
      attempt: 1,
    });

    // Run was completed (single task done → all required terminal).
    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    const completeArgs = mockLedgerCompleteRun.mock.calls[0]?.[2] as { status: string };
    expect(completeArgs.status).toBe('completed');

    // Helmsman waiter woken — synthetic StepResultMessage written to
    // the original waiter's stepExecutionId, then markWaiterNotified.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const wakeup = mockAddStepResult.mock.calls[0]?.[1] as {
      stepExecutionId: string;
      sessionId: string;
      status: string;
      traceId: string;
    };
    expect(wakeup.stepExecutionId).toBe(HELMSMAN_STEP);
    expect(wakeup.sessionId).toBe(HELMSMAN_SESSION);
    expect(wakeup.status).toBe('SUCCEEDED');
    expect(wakeup.traceId).toBe('trace-helmsman');
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
    expect(mockMarkWaiterNotified.mock.calls[0]?.[2]).toMatchObject({
      waiterId: 'waiter-helmsman',
      outcome: 'completed',
    });

    // Completion-pending row cleared so the sweeper doesn't re-fire.
    expect(mockClearCompletionPending).toHaveBeenCalledOnce();
  });
});

// ─── dispatchNextOrTerminate downstream-failure handling ────────────────────

describe('dispatchNextOrTerminate downstream-failure handling', () => {
  // Phase 2.3.1b — dispatchTask now throws on invariant /
  // input-resolution failures. Without explicit catch+failure
  // handling in dispatchNextOrTerminate, the throw escapes back to
  // the result-consumer adapter; the producer's completion_pending
  // was already cleared, retries quarantine, run stays running with
  // no row for the new task — silent hang.
  it('catches downstream dispatch failures and routes through applyFailureMode', async () => {
    // Workflow: task-a (succeeded, producer) + task-b (would-be
    // dispatched, but buildTaskInputRef fails for it).
    const workflow = {
      slug: 'two-task-skill',
      tasks: [
        { taskId: 'task-a', name: 'A', goal: 'a', optional: false, agent: 'r' },
        {
          taskId: 'task-b',
          name: 'B',
          goal: 'b',
          optional: false,
          agent: 'r',
          dependsOn: ['task-a'],
        },
      ],
    };
    // Run snapshot: task-a is already succeeded (its
    // onWorkflowTaskComplete already cleared completion_pending and
    // called dispatchNextOrTerminate). task-b has no row yet — but after
    // the dispatch failure is persisted, the reload from
    // dispatchNextOrTerminate (called by applyFailureMode) sees task-b
    mockLoadRunById.mockImplementation(async () => {
      const persisted = mockLedgerRecordTaskResult.mock.calls.length > 0;
      const taskARow = buildTaskRow({ taskId: 'task-a', status: 'succeeded' });
      return persisted
        ? buildRunDetail(
            [taskARow, buildTaskRow({ taskId: 'task-b', status: 'failed' })],
            'running',
          )
        : buildRunDetail([taskARow], 'running');
    });
    mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' });
    // Ready-set says task-b is now dispatchable.
    mockComputeReadyTasksWithWhen.mockReturnValue({
      ready: [workflow.tasks[1]],
      skipped: [],
      errors: [],
    });
    // dispatchTask reaches buildDelegateTaskInput which throws —
    // simulate an upstream resolution failure (e.g., DeriveSchemaError
    // or missing pinned revision).
    mockBuildDelegateTaskInput.mockRejectedValueOnce(new Error('downstream resolution failed'));
    mockGetSessionState.mockResolvedValue({});
    mockLoadPendingWaiters.mockResolvedValue([]);

    // Direct call — simulates what onWorkflowTaskComplete invokes
    // after recordTaskOutcome lands for the producer.
    const { dispatchNextOrTerminate } = await import('../WorkflowRunHarness.js');
    await dispatchNextOrTerminate(deps, TENANT, RUN_ID);

    // The downstream failure must NOT escape — it must surface as a
    // failed task row + applyFailureMode → completeRun(failed). If
    // it escaped, the test would reject; instead, the failure
    // becomes a durable run-level fail.
    expect(mockLedgerRecordTaskResult).toHaveBeenCalledOnce();
    const recordArgs = mockLedgerRecordTaskResult.mock.calls[0]?.[2] as {
      taskId: string;
      status: string;
      failureReason: string;
    };
    expect(recordArgs.taskId).toBe('task-b');
    expect(recordArgs.status).toBe('failed');
    expect(recordArgs.failureReason).toBe('downstream resolution failed');
    // applyFailureMode → completeRun(failed) fires.
    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    expect(mockLedgerCompleteRun.mock.calls[0]?.[2]).toMatchObject({ status: 'failed' });
  });
});

// ─── Phase 3 — pause / resume scenarios ─────────────────────────────────────
//
// Service-level coverage for the spec's Phase 3 test list. Each scenario
// drives a real harness call sequence with mocked ledger / Redis /
// PayloadStore boundaries.

describe('Phase 3 — pause/resume scenarios', () => {
  const HELMSMAN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const HELMSMAN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const STEP_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const STEP_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  it('signal_blocked from Runner → contract surfaces via notifyWaiters with contractRef', async () => {
    // Runner emits PAUSED with a task_contract_violation contract ref.
    // Harness pauseRunForTask → notifyWaiters wakes the Helmsman.
    // Verifies the wakeup carries the contract via the output envelope.
    const taskRow = buildTaskRow({ status: 'running', attempt: 1 });
    mockListTaskRows.mockResolvedValue([taskRow]);
    mockCasCompleteTask.mockResolvedValue(true);
    mockLoadRunById.mockResolvedValue(buildRunDetail([taskRow], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'signal-skill',
        tasks: [{ taskId: TASK_ID, name: 'A', goal: 'a', optional: false, agent: 'r' }],
      },
      source: 'revision',
    });
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-1',
        runId: RUN_ID,
        waiterSessionId: HELMSMAN_A,
        waiterStepExecutionId: STEP_A,
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'trace-a',
    });

    const contractRef = 'inline:Y29udHJhY3Q=';
    await onWorkflowTaskComplete(deps, {
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outcome: { kind: 'paused', contractRef },
    });

    // pauseRunForTask sequence: CAS task → ledgerPauseRun → attention
    // → notifyWaiters → mark waiter notified with outcome 'paused'.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    expect(mockCasCompleteTask.mock.calls[0]?.[2]).toMatchObject({ status: 'paused' });
    expect(mockLedgerPauseRun).toHaveBeenCalledOnce();
    const pauseArgs = mockLedgerPauseRun.mock.calls[0]?.[3] as { payloadRef?: string };
    expect(pauseArgs.payloadRef).toBe(contractRef);

    // Synthetic SUCCEEDED carries the contract via the output envelope.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const wake = mockAddStepResult.mock.calls[0]?.[1] as {
      stepExecutionId: string;
      status: string;
      outputRef: string;
      idempotencyKey: string;
    };
    expect(wake.stepExecutionId).toBe(STEP_A);
    expect(wake.status).toBe('SUCCEEDED');
    // Idempotency key keyed on waiter row id so future cycles get
    // unique keys (verified explicitly in the next test).
    expect(wake.idempotencyKey).toBe('notify-waiter:waiter-1:paused');

    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
    expect(mockMarkWaiterNotified.mock.calls[0]?.[2]).toMatchObject({
      waiterId: 'waiter-1',
      outcome: 'paused',
    });
  });

  it('task_contract_violation pause keeps Runner outputRef on the task row', async () => {
    const taskRow = buildTaskRow({ status: 'running', attempt: 1 });
    mockListTaskRows.mockResolvedValue([taskRow]);
    mockCasCompleteTask.mockResolvedValue(true);
    mockLoadRunById.mockResolvedValue(buildRunDetail([taskRow], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 's',
        tasks: [{ taskId: TASK_ID, name: 'A', goal: 'a', optional: false, agent: 'r' }],
      },
      source: 'revision',
    });
    mockLoadPendingWaiters.mockResolvedValue([]);

    const runnerOutputRef = 'inline:runnerOutput=';
    const contractRef = 'inline:resumeContract=';
    await onWorkflowTaskComplete(deps, {
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outcome: { kind: 'paused', contractRef, taskOutputRef: runnerOutputRef },
    });

    expect(mockCasCompleteTask.mock.calls[0]?.[2]).toMatchObject({
      status: 'paused',
      outputRef: runnerOutputRef,
    });
    const pauseArgs = mockLedgerPauseRun.mock.calls[0]?.[3] as { payloadRef?: string };
    expect(pauseArgs.payloadRef).toBe(contractRef);
  });

  it('non-SubagentHandoff contractRef → passes through unchanged (legacy compat)', async () => {
    const taskRow = buildTaskRow({ status: 'running', attempt: 1 });
    mockListTaskRows.mockResolvedValue([taskRow]);
    mockCasCompleteTask.mockResolvedValue(true);
    mockLoadRunById.mockResolvedValue(buildRunDetail([taskRow], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 's',
        tasks: [{ taskId: TASK_ID, name: 'A', goal: 'a', optional: false, agent: 'r' }],
      },
      source: 'revision',
    });
    mockLoadPendingWaiters.mockResolvedValue([]);

    // Already-shaped resume contract (e.g., human task pause or
    // task_contract_violation). Wrapper should leave it alone.
    const existingContract = {
      pauseCause: 'task_contract_violation',
      resumePrompt: 'fix the output',
      allowedResumeModes: ['replace_output'],
    };
    const originalContractRef = `inline:${Buffer.from(JSON.stringify(existingContract)).toString('base64')}`;

    const storeMock = vi.fn().mockResolvedValue('inline:wrapped3=');
    const retrieveMock = vi.fn().mockResolvedValue(existingContract);
    const localDeps: HarnessDeps = {
      ...deps,
      payloadStore: { store: storeMock, retrieve: retrieveMock } as never,
    };

    await onWorkflowTaskComplete(localDeps, {
      tenantId: TENANT,
      workflowExecution: { runId: RUN_ID, taskId: TASK_ID, attempt: 1 },
      outcome: { kind: 'paused', contractRef: originalContractRef },
    });

    // store NOT called (no wrapping needed); pauseRun receives the
    // original ref.
    expect(storeMock).not.toHaveBeenCalled();
    const pauseArgs = mockLedgerPauseRun.mock.calls[0]?.[3] as { payloadRef?: string };
    expect(pauseArgs.payloadRef).toBe(originalContractRef);
  });

  it('repeated pause cycles use unique idempotency keys per waiter', async () => {
    // Cycle 1: waiter-1 is the active waiter, gets notified 'paused'
    // with key `notify-waiter:waiter-1:paused`.
    // Cycle 2 (after resume): waiter-2 is the new active waiter, gets
    // notified 'paused' with key `notify-waiter:waiter-2:paused` —
    // distinct from cycle 1 even though the session is the same.
    //
    // The harness keys the synthetic addStepResult on the waiter row
    // id, NOT the session id, precisely so that re-pause cycles in the
    // same session don't collide on idempotency.
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'trace-a',
    });

    // Cycle 1 — waiter-1.
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-1',
        runId: RUN_ID,
        waiterSessionId: HELMSMAN_A,
        waiterStepExecutionId: STEP_A,
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN_ID, outcome: 'paused' });

    const cycle1 = mockAddStepResult.mock.calls[0]?.[1] as { idempotencyKey: string };
    expect(cycle1.idempotencyKey).toBe('notify-waiter:waiter-1:paused');

    // Reset call history so cycle 2's assertions are independent.
    mockAddStepResult.mockClear();
    mockMarkWaiterNotified.mockClear();

    // Cycle 2 — waiter-2 (fresh row for the same session).
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-2',
        runId: RUN_ID,
        waiterSessionId: HELMSMAN_A,
        waiterStepExecutionId: STEP_A,
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN_ID, outcome: 'paused' });

    const cycle2 = mockAddStepResult.mock.calls[0]?.[1] as { idempotencyKey: string };
    expect(cycle2.idempotencyKey).toBe('notify-waiter:waiter-2:paused');
    expect(cycle2.idempotencyKey).not.toBe(cycle1.idempotencyKey);
  });

  it('cross-session resume: A is handed_off, B becomes the active waiter', async () => {
    // Helmsman A is the only pending waiter when B's resume calls
    // notifyWaiters(handed_off). The handoff payload carries
    // resumedBy=B so A's session can render "the run was taken over"
    // when its synthetic SUCCEEDED lands.
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-A',
        runId: RUN_ID,
        waiterSessionId: HELMSMAN_A,
        waiterStepExecutionId: STEP_A,
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetStepState.mockResolvedValue({
      stepId: 'workflow-run-start',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'inline:in=',
      traceId: 'trace-a',
    });

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'handed_off',
      handoffPayload: {
        resumedBy: HELMSMAN_B,
        actorKind: 'human',
        runStatusAtHandoff: 'running',
        nextStep: 'released_do_not_poll',
      },
    });

    // A's synthetic wakeup carries the handoff envelope.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const wake = mockAddStepResult.mock.calls[0]?.[1] as {
      stepExecutionId: string;
      sessionId: string;
      idempotencyKey: string;
    };
    expect(wake.stepExecutionId).toBe(STEP_A);
    expect(wake.sessionId).toBe(HELMSMAN_A);
    expect(wake.idempotencyKey).toBe('notify-waiter:waiter-A:handed_off');

    // A's waiter row is marked notified with outcome=handed_off so
    // the next loadPendingWaiters call doesn't surface it again.
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
    expect(mockMarkWaiterNotified.mock.calls[0]?.[2]).toMatchObject({
      waiterId: 'waiter-A',
      outcome: 'handed_off',
    });

    // The handoff envelope referenced in the output payload carries the
    // full takeover block (verified via the payloadStore.store call args).
    const storeCalls = (deps.payloadStore.store as ReturnType<typeof vi.fn>).mock.calls;
    const lastStored = storeCalls[storeCalls.length - 1]?.[0] as {
      data: {
        handoffPayload?: {
          resumedBy: string;
          actorKind?: string;
          runStatusAtHandoff?: string;
          nextStep: string;
        };
      };
    };
    expect(lastStored.data.handoffPayload).toEqual({
      resumedBy: HELMSMAN_B,
      actorKind: 'human',
      runStatusAtHandoff: 'running',
      nextStep: 'released_do_not_poll',
    });
  });
});

// ─── Phase 4 — workflow.run.cancel ──────────────────────────────────────────

describe('cancelRun — Plan 132v2 §Phase 4 (4.5c replay-safe)', () => {
  it('cascades BEFORE bulk-cancel, clears completion_pending only after, then completeRun(cancelled)', async () => {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([
      {
        id: 'pending-1',
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '11111111-1111-1111-1111-111111111111',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
      {
        id: 'pending-2',
        runId: RUN_ID,
        taskId: 'task-b',
        attempt: 1,
        workerSessionId: '22222222-2222-2222-2222-222222222222',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    ]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: ['task-a', 'task-b'],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLedgerCompleteRun.mockResolvedValueOnce(true); // CAS landed
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await cancelRun(deps, TENANT, RUN_ID);

    expect(mockListCompletionPendingForRun).toHaveBeenCalledOnce();
    expect(mockAddControlMessage).toHaveBeenCalledTimes(2);
    expect(mockCancelNonTerminalTasksForRun).toHaveBeenCalledOnce();
    expect(mockClearAllCompletionPendingForRun).toHaveBeenCalledOnce();
    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();

    // Ordering: cascade BEFORE bulk-cancel BEFORE clearPending BEFORE completeRun.
    const listOrder = mockListCompletionPendingForRun.mock.invocationCallOrder[0]!;
    const ctrlOrder = mockAddControlMessage.mock.invocationCallOrder[0]!;
    const cancelOrder = mockCancelNonTerminalTasksForRun.mock.invocationCallOrder[0]!;
    const clearOrder = mockClearAllCompletionPendingForRun.mock.invocationCallOrder[0]!;
    const completeOrder = mockLedgerCompleteRun.mock.invocationCallOrder[0]!;
    expect(listOrder).toBeLessThan(ctrlOrder);
    expect(ctrlOrder).toBeLessThan(cancelOrder);
    expect(cancelOrder).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(completeOrder);

    // Each cancel_run targets a worker session with a deterministic
    // idempotency key tied to the workflow runId (so re-cancelling the
    // same run doesn't double-deliver to the Runner).
    const ctrlMessages = mockAddControlMessage.mock.calls.map(
      (c) => c[1] as Record<string, unknown>,
    );
    expect(ctrlMessages.every((m) => m.type === 'cancel_run')).toBe(true);
    const targets = ctrlMessages.map((m) => m.runId);
    expect(targets).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
    const idempotencyKeys = ctrlMessages.map((m) => m.idempotencyKey);
    expect(idempotencyKeys[0]).toBe(
      `workflow-cancel:${RUN_ID}:11111111-1111-1111-1111-111111111111`,
    );

    expect(result.cancelledTaskIds).toEqual(['task-a', 'task-b']);
    expect(result.interruptedSessions).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);

    // An operation task has no Runner session — its workerSessionId IS the step
    // execution id — so the control message alone never reaches its executor.
    // The step abort is the half of the cascade that stops the running work.
    expect(mockPublishStepAbort.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['11111111-1111-1111-1111-111111111111', 'cancelled'],
      ['22222222-2222-2222-2222-222222222222', 'cancelled'],
    ]);

    // ...and durably, per ATTEMPT, so an executor that never saw the publish —
    // the job still queued, or claimed but not yet listening — refuses the job
    // rather than starting a container for a run that was cancelled.
    expect(mockMarkStepCancelled.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ['11111111-1111-1111-1111-111111111111', 1, 'cancelled'],
      ['22222222-2222-2222-2222-222222222222', 1, 'cancelled'],
    ]);
  });

  it('replays cleanly after partial cascade — second invocation re-delivers cancel_run to remaining workers', async () => {
    // Crash simulation: first invocation fully delivered, second
    // invocation finds same completion_pending state (cascade
    // idempotency at the message layer means re-delivery is safe).
    // The retry must re-cascade to all worker sessions even though
    // the original call already did so.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValue([
      {
        id: 'pending-1',
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '11111111-1111-1111-1111-111111111111',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    ]);
    mockCancelNonTerminalTasksForRun.mockResolvedValue({
      cancelledTaskIds: ['task-a'],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValue(undefined);
    // CAS lost on retry — another path (or our first invocation)
    // already wrote terminal. completeRun returns false; cancelRun
    // still completes successfully.
    mockLedgerCompleteRun.mockResolvedValue(false);
    mockLoadPendingWaiters.mockResolvedValue([]);

    await cancelRun(deps, TENANT, RUN_ID);
    await cancelRun(deps, TENANT, RUN_ID);

    // Both invocations re-cascade. cancel_run's idempotencyKey
    // protects the Runner from double-processing.
    expect(mockAddControlMessage).toHaveBeenCalledTimes(2);
    expect(mockListCompletionPendingForRun).toHaveBeenCalledTimes(2);
  });

  it('falls back to non-terminal task rows when completion_pending is empty', async () => {
    // Defensive: if a non-terminal task row exists without a matching
    // completion_pending entry, scan worker_session_id from the task
    // row so the cascade still reaches the Runner.
    mockLoadRunById.mockResolvedValue(
      buildRunDetail(
        [
          buildTaskRow({
            taskId: 'task-orphan',
            status: 'running',
            workerSessionId: '33333333-3333-3333-3333-333333333333',
          }),
        ],
        'running',
      ),
    );
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: ['task-orphan'],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLedgerCompleteRun.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await cancelRun(deps, TENANT, RUN_ID);

    expect(mockAddControlMessage).toHaveBeenCalledOnce();
    const ctrl = mockAddControlMessage.mock.calls[0]?.[1] as { runId: string };
    expect(ctrl.runId).toBe('33333333-3333-3333-3333-333333333333');
    expect(result.interruptedSessions).toEqual(['33333333-3333-3333-3333-333333333333']);
  });

  it('Plan 5.4c: cascade delivery failure throws CancelCascadeDeliveryError; does NOT clear pending or complete run', async () => {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([
      {
        id: 'pending-1',
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '11111111-1111-1111-1111-111111111111',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
      {
        id: 'pending-2',
        runId: RUN_ID,
        taskId: 'task-b',
        attempt: 1,
        workerSessionId: '22222222-2222-2222-2222-222222222222',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    ]);
    mockAddControlMessage
      .mockRejectedValueOnce(new Error('redis ECONNRESET'))
      .mockResolvedValueOnce(undefined);

    await expect(cancelRun(deps, TENANT, RUN_ID)).rejects.toThrow(/cancel_run cascade failed/);

    // The cascade was attempted for both targets (the loop continues
    // through the remaining sessions before throwing) so previously-
    // successful sessions get their idempotent message — only the
    // failed one needs a retry.
    expect(mockAddControlMessage).toHaveBeenCalledTimes(2);
    // CRUCIAL: the bulk-cancel + clearAllCompletionPendingForRun +
    // completeRun steps did NOT run; the next cancelRun call can
    // rediscover via completion_pending and re-cascade.
    expect(mockCancelNonTerminalTasksForRun).not.toHaveBeenCalled();
    expect(mockClearAllCompletionPendingForRun).not.toHaveBeenCalled();
    expect(mockLedgerCompleteRun).not.toHaveBeenCalled();
  });

  it('Plan 4.5d: reason + cancelledTaskIds + interruptedSessions land in canonical attention payload, no second row', async () => {
    // The reason MUST flow into the SAME attention row as terminalStatus,
    // not a second pending item — list_attention would otherwise surface
    // the cancellation twice.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([
      {
        id: 'pending-1',
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '11111111-1111-1111-1111-111111111111',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    ]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: ['task-a'],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLedgerCompleteRun.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([]);

    await cancelRun(deps, TENANT, RUN_ID, { reason: 'user requested stop' });

    // EXACTLY ONE attention insert — the canonical row written inside
    // completeRun's TX. The previous design wrote a second row.
    expect(mockAddAttentionItem).toHaveBeenCalledOnce();
    // addAttentionItem signature: (db, tenantId, args, tx?) → args at [2].
    const attArgs = mockAddAttentionItem.mock.calls[0]?.[2] as {
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(attArgs.kind).toBe('workflow_run_cancelled');
    expect(attArgs.payload).toMatchObject({
      terminalStatus: 'cancelled',
      reason: 'user requested stop',
      // Unattributed cancels stay system-classified (schema default).
      cancelledBy: 'system',
      cancelledTaskIds: ['task-a'],
      interruptedSessions: ['11111111-1111-1111-1111-111111111111'],
    });
    // The terminal CAS stamps the provenance columns too.
    const completeParams = mockLedgerCompleteRun.mock.calls[0]?.[2] as {
      status: string;
      cancellation?: { cancelledBy: string; reason?: string };
    };
    expect(completeParams.cancellation).toEqual({
      cancelledBy: 'system',
      reason: 'user requested stop',
    });
  });

  it('operator cancel — terminal state carries cancelledBy=operator and the waiter wake-up envelope marks the deliberate stop', async () => {
    // Operator-cancel legibility: an operator cancel must reach the parked
    // Helmsman as INTENT ("stop, don't auto-retry, ask the user"), not as a
    // generic failure. Two assertions:
    //   (a) the terminal CAS receives cancellation.cancelledBy='operator'
    //       (→ workflow_runs.cancelled_by);
    //   (b) the synthetic wake-up envelope carries the cancellation block
    //       with retryPolicy 'do_not_restart_without_explicit_user_instruction'.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: [],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLedgerCompleteRun.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-1',
        waiterSessionId: '44444444-4444-4444-4444-444444444444',
        waiterStepExecutionId: '55555555-5555-5555-5555-555555555555',
      },
    ]);
    mockGetStepState.mockResolvedValue({
      status: 'PAUSED',
      stepId: 'step-1',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      attempt: 1,
      traceId: 'trace-1',
      inputRef: 'inline:e30=',
    });
    const storedEnvelopes: Array<Record<string, unknown>> = [];
    const localDeps: HarnessDeps = {
      ...deps,
      payloadStore: {
        store: vi.fn(async (args: { data: Record<string, unknown> }) => {
          storedEnvelopes.push(args.data);
          return 'inline:envelope=';
        }),
        retrieve: vi.fn(),
      } as never,
    };

    await cancelRun(localDeps, TENANT, RUN_ID, {
      cancelledBy: 'operator',
      reason: 'operator stopped the run',
    });

    // (a) terminal state carries the actor.
    const completeParams = mockLedgerCompleteRun.mock.calls[0]?.[2] as {
      status: string;
      cancellation?: { cancelledBy: string; reason?: string };
    };
    expect(completeParams.status).toBe('cancelled');
    expect(completeParams.cancellation).toEqual({
      cancelledBy: 'operator',
      reason: 'operator stopped the run',
    });

    // (b) the wake-up payload Helmsman receives carries the operator-cancel
    // marker + the schema-carried retry affordance.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const envelope = storedEnvelopes.find((e) => e['outcome'] === 'cancelled');
    expect(envelope).toBeDefined();
    expect(envelope?.['cancellation']).toEqual({
      cancelledBy: 'operator',
      reason: 'operator stopped the run',
      retryPolicy: 'do_not_restart_without_explicit_user_instruction',
    });
  });

  it('system cancel — wake-up envelope cancellation block stays may_restart', async () => {
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: [],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLedgerCompleteRun.mockResolvedValueOnce(true);
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'waiter-2',
        waiterSessionId: '44444444-4444-4444-4444-444444444444',
        waiterStepExecutionId: '55555555-5555-5555-5555-555555555555',
      },
    ]);
    mockGetStepState.mockResolvedValue({
      status: 'PAUSED',
      stepId: 'step-1',
      stepType: 'workflow',
      operationId: 'workflow.run.start',
      attempt: 1,
      traceId: 'trace-1',
      inputRef: 'inline:e30=',
    });
    const storedEnvelopes: Array<Record<string, unknown>> = [];
    const localDeps: HarnessDeps = {
      ...deps,
      payloadStore: {
        store: vi.fn(async (args: { data: Record<string, unknown> }) => {
          storedEnvelopes.push(args.data);
          return 'inline:envelope=';
        }),
        retrieve: vi.fn(),
      } as never,
    };

    await cancelRun(localDeps, TENANT, RUN_ID);

    const envelope = storedEnvelopes.find((e) => e['outcome'] === 'cancelled');
    expect(envelope?.['cancellation']).toEqual({
      cancelledBy: 'system',
      retryPolicy: 'may_restart',
    });
  });

  it('Plan 4.5b: completeRun CAS miss skips waiter notify + post-run hooks', async () => {
    // Race: a normal completion path won the run-row terminal write
    // before our cancel arrived. completeRun's CAS misses; we must
    // NOT fire a duplicate waiter WAKEUP (synthetic step result +
    // markWaiterNotified) or re-run post-run hooks (the winning path
    // already did).
    //
    // loadRunById sequence: (1) cancelRun's top-of-function load,
    // (2) completeRun's pre-CAS guard load (still `running` → CAS attempted,
    // then misses), (3) the fallback's reload — which now reflects the WINNER's
    // persisted status (`completed`), because the normal-completion path that
    // beat us wrote `completed`, not `cancelled`.
    mockLoadRunById
      .mockResolvedValueOnce(buildRunDetail([], 'running'))
      .mockResolvedValueOnce(buildRunDetail([], 'running'))
      .mockResolvedValueOnce(buildRunDetail([], 'completed'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: [],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLoadPendingWaiters.mockResolvedValue([
      { waiterSessionId: 'waiter-session-1', waiterStepExecutionId: 'waiter-step-1' },
    ]);
    // CAS miss — concurrent path won.
    mockLedgerCompleteRun.mockResolvedValueOnce(false);

    await cancelRun(deps, TENANT, RUN_ID);

    expect(mockLedgerCompleteRun).toHaveBeenCalledOnce();
    // CAS-miss short-circuit: the winner already did the terminal work, so the
    // duplicate-sensitive writes stay skipped — no waiter wakeup, no attention.
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockAddAttentionItem).not.toHaveBeenCalled();
    const runUpdates = mockAppendSessionEvent.mock.calls
      .map((c) => c[3] as { eventType?: string; workflowRunUpdate?: { status?: string } })
      .filter((ev) => ev?.eventType === 'WorkflowRunUpdate');
    expect(runUpdates.map((ev) => ev.workflowRunUpdate?.status)).toContain('completed');
    expect(runUpdates.map((ev) => ev.workflowRunUpdate?.status)).not.toContain('cancelled');
  });

  it('Plan 182 (review): CAS miss to a real cancel emits the persisted cancelled status', async () => {
    // Race variant: a DIFFERENT cancel path (or a retry of this one) won the
    // terminal CAS, so the persisted status genuinely IS `cancelled`. The
    // fallback must then emit `cancelled` — proving the fallback reflects the
    // reloaded status rather than dropping the emit.
    mockLoadRunById
      .mockResolvedValueOnce(buildRunDetail([], 'running'))
      .mockResolvedValueOnce(buildRunDetail([], 'running'))
      .mockResolvedValueOnce(buildRunDetail([], 'cancelled'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: [],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLoadPendingWaiters.mockResolvedValue([
      { waiterSessionId: 'waiter-session-1', waiterStepExecutionId: 'waiter-step-1' },
    ]);
    mockLedgerCompleteRun.mockResolvedValueOnce(false);

    await cancelRun(deps, TENANT, RUN_ID);

    const cancelledRunUpdate = mockAppendSessionEvent.mock.calls.find((c) => {
      const ev = c[3] as { eventType?: string; workflowRunUpdate?: { status?: string } };
      return ev?.eventType === 'WorkflowRunUpdate' && ev.workflowRunUpdate?.status === 'cancelled';
    });
    expect(cancelledRunUpdate).toBeDefined();
  });

  it('Plan 182 (review): CAS miss with a still-non-terminal run emits no fallback', async () => {
    // Defensive: if `completeRun` returned false but the reloaded run is
    // somehow not terminal (no concurrent winner visible yet), the cancel
    // path must NOT invent a terminal WorkflowRunUpdate.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockListCompletionPendingForRun.mockResolvedValueOnce([]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: [],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLoadPendingWaiters.mockResolvedValue([
      { waiterSessionId: 'waiter-session-1', waiterStepExecutionId: 'waiter-step-1' },
    ]);
    mockLedgerCompleteRun.mockResolvedValueOnce(false);

    await cancelRun(deps, TENANT, RUN_ID);

    const runUpdates = mockAppendSessionEvent.mock.calls
      .map((c) => c[3] as { eventType?: string })
      .filter((ev) => ev?.eventType === 'WorkflowRunUpdate');
    expect(runUpdates).toHaveLength(0);
  });
});

// ─── Phase 5.3 — reconcileStaleRunForTenant sweeper ─────────────────────────

describe('reconcileStaleRunForTenant — Plan 132v2 §Phase 5.3', () => {
  const WORKER_SESSION_ID = '11111111-1111-1111-1111-111111111111';

  function buildPendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pending-id',
      runId: RUN_ID,
      taskId: 'task-a',
      attempt: 1,
      workerSessionId: WORKER_SESSION_ID,
      detectedAt: new Date(),
      dueAt: new Date(Date.now() - 60_000),
      attemptCount: 0,
      lastError: null,
      ...overrides,
    };
  }

  function setupAgentTaskRow(overrides: Record<string, unknown> = {}): void {
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({
        taskId: 'task-a',
        attempt: 1,
        status: 'running',
        sessionId: WORKER_SESSION_ID,
        workerSessionId: WORKER_SESSION_ID,
        ...overrides,
      }),
    ]);
  }

  it('returns empty result when no due rows', async () => {
    mockListDueCompletionPending.mockResolvedValueOnce([]);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(result).toEqual({
      scanned: 0,
      orphans: 0,
      redrives: 0,
      bumps: 0,
      operationBumps: 0,
      zombies: 0,
      escalations: 0,
      errors: 0,
    });
    expect(mockGetSessionState).not.toHaveBeenCalled();
  });

  it('Plan 5.4a: operation task (sessionId NULL on row) → bump dueAt, do NOT touch SessionHotState', async () => {
    // The pending row's workerSessionId references an executor job, not
    // a Runner session. SessionHotState.get returning null for an
    // operation task would (pre-fix) be misclassified as orphan and
    // get recovered, deleting the row that the executor result is
    // about to land against. The fix branches on the task row's
    // sessionId BEFORE consulting SessionHotState.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({
        taskId: 'task-a',
        attempt: 1,
        status: 'running',
        sessionId: null, // operation task — no Runner session
        workerSessionId: WORKER_SESSION_ID,
      }),
    ]);
    mockBumpCompletionPendingDueAt.mockResolvedValueOnce(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    // CRUCIAL: getSessionState NOT consulted; orphan recovery NOT run.
    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockRecoverOrphanedTaskAttempt).not.toHaveBeenCalled();
    // dueAt bumped so the executor has more time.
    expect(mockBumpCompletionPendingDueAt).toHaveBeenCalledOnce();
    expect(result.operationBumps).toBe(1);
    expect(result.orphans).toBe(0);
    expect(result.bumps).toBe(0);
  });

  it('orphan branch: hot state missing → recoverOrphanedTaskAttempt + re-dispatch', async () => {
    // The Runner session never started — Redis has nothing for this
    // workerSessionId. The sweeper recovers the orphan by deleting the
    // task row + completion_pending so the next scheduling pass
    // re-claims fresh, then drives forward via dispatchNextOrTerminate
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce(null);
    mockRecoverOrphanedTaskAttempt.mockResolvedValueOnce(true);
    // dispatchNextOrTerminate setup — minimal mocks so the call doesn't
    // throw. After orphan recovery the task row is gone, so listTaskRows
    // returns no row → workflow definition + computeReadyTasksWithWhen
    // determine the next dispatch.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockRecoverOrphanedTaskAttempt).toHaveBeenCalledOnce();
    expect(mockRecoverOrphanedTaskAttempt.mock.calls[0]).toEqual([
      deps.db,
      TENANT,
      RUN_ID,
      'task-a',
      1,
    ]);
    expect(mockComputeReadyTasksWithWhen).toHaveBeenCalled();
    expect(result.orphans).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.redrives).toBe(0);
    expect(result.bumps).toBe(0);
  });

  it('orphan branch with concurrent recovery: bumps dueAt instead of spinning', async () => {
    // Another sweeper instance got there first; recoverOrphanedTaskAttempt
    // returns false. We bump dueAt so this row doesn't keep showing up as
    // due on every tick.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce(null);
    mockRecoverOrphanedTaskAttempt.mockResolvedValueOnce(false);
    mockBumpCompletionPendingDueAt.mockResolvedValueOnce(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockBumpCompletionPendingDueAt).toHaveBeenCalledOnce();
    expect(result.bumps).toBe(1);
    expect(result.orphans).toBe(0);
  });

  it('terminal SUCCEEDED branch: re-drives routeRunnerTerminalToHarness with outputRef', async () => {
    // Runner finished successfully but the result-consumer intercept
    // dropped (e.g., orchestrator restart between Runner-terminal write
    // and the harness call). Hot state still carries finalOutputRef;
    // sweeper re-drives via the SAME adapter path.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      finalOutputRef: 'inline:result=',
      traceId: 'trace-recovered',
    });
    mockCasCompleteTask.mockResolvedValueOnce(true);
    mockLoadRunById.mockResolvedValue(buildRunDetail([buildTaskRow({ status: 'succeeded' })]));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
    mockLoadPendingWaiters.mockResolvedValue([]);
    mockLedgerCompleteRun.mockResolvedValue(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(result.redrives).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.orphans).toBe(0);
    // The redrive routes through onWorkflowTaskComplete (called by
    // routeRunnerTerminalToHarness). casCompleteTask landing means the
    // task row was successfully transitioned to 'succeeded'.
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    expect(mockCasCompleteTask.mock.calls[0]?.[2]).toMatchObject({
      runId: RUN_ID,
      taskId: 'task-a',
      attempt: 1,
      status: 'succeeded',
      outputRef: 'inline:result=',
    });
  });

  it('terminal SUCCEEDED without finalOutputRef: degrades to orphan recovery (defensive)', async () => {
    // Hot state in SUCCEEDED but no outputRef — degenerate. Rather
    // than throwing (the intercept adapter requires outputRef), the
    // sweeper treats it as an orphan and lets the next scheduling
    // pass retry.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      // no finalOutputRef
    });
    mockRecoverOrphanedTaskAttempt.mockResolvedValueOnce(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockRecoverOrphanedTaskAttempt).toHaveBeenCalledOnce();
    expect(result.orphans).toBe(1);
    expect(result.redrives).toBe(0);
  });

  it('terminal PAUSED branch: re-drives with contractRef from requestedInputRef', async () => {
    // Runner paused with a structured contract (signal_blocked or
    // human-task pause); hot state carries it on requestedInputRef.
    // Sweeper re-drives so the contract surfaces to the Helmsman.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce({
      status: 'PAUSED',
      requestedInputRef: 'inline:contract=',
      traceId: 'trace-paused',
    });
    mockCasCompleteTask.mockResolvedValueOnce(true);
    mockLoadRunById.mockResolvedValue(
      buildRunDetail([buildTaskRow({ status: 'paused' })], 'paused'),
    );
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(result.redrives).toBe(1);
    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as {
      status: string;
      outputRef?: string;
    };
    expect(casArgs.status).toBe('paused');
    expect(casArgs.outputRef).toBe('inline:contract=');
  });

  it('running branch: hot state in RUNNING → bump dueAt', async () => {
    // The Runner is still doing real work — the dispatch row is just
    // waiting for the result. Bump dueAt so the next sweeper check
    // gives the Runner more time.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce({
      status: 'RUNNING',
    });
    mockBumpCompletionPendingDueAt.mockResolvedValueOnce(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockBumpCompletionPendingDueAt).toHaveBeenCalledOnce();
    expect(result.bumps).toBe(1);
    expect(result.orphans).toBe(0);
    expect(result.redrives).toBe(0);
    // No orphan recovery + no terminal redrive.
    expect(mockRecoverOrphanedTaskAttempt).not.toHaveBeenCalled();
  });

  it('per-row error is bumped with last_error so the batch continues', async () => {
    // A single bad row must not stall the rest. Bump dueAt with the
    // last_error and keep going.
    const rowA = buildPendingRow({ id: 'p-a', taskId: 'task-a' });
    const rowB = buildPendingRow({ id: 'p-b', taskId: 'task-b' });
    mockListDueCompletionPending.mockResolvedValueOnce([rowA, rowB]);
    // Two agent task rows so the discriminator picks the SessionHotState path.
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({
        taskId: 'task-a',
        attempt: 1,
        status: 'running',
        sessionId: WORKER_SESSION_ID,
        workerSessionId: WORKER_SESSION_ID,
      }),
      buildTaskRow({
        taskId: 'task-b',
        attempt: 1,
        status: 'running',
        sessionId: WORKER_SESSION_ID,
        workerSessionId: WORKER_SESSION_ID,
      }),
    ]);
    mockGetSessionState
      .mockRejectedValueOnce(new Error('redis ECONNRESET'))
      .mockResolvedValueOnce({ status: 'RUNNING' });
    mockBumpCompletionPendingDueAt.mockResolvedValue(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.bumps).toBe(1);
    // The second row was still processed.
    expect(mockGetSessionState).toHaveBeenCalledTimes(2);
    expect(mockBumpCompletionPendingDueAt).toHaveBeenCalledTimes(2);
    // Error path bumped with last_error.
    const errorBump = mockBumpCompletionPendingDueAt.mock.calls.find((c) => {
      const args = c[2] as { lastError?: string };
      return args.lastError !== undefined;
    });
    expect(errorBump).toBeDefined();
    const errorBumpArgs = errorBump![2] as { lastError: string };
    expect(errorBumpArgs.lastError).toMatch(/ECONNRESET/);
  });

  it('respects the limit option', async () => {
    mockListDueCompletionPending.mockResolvedValueOnce([]);

    await reconcileStaleRunForTenant(deps, TENANT, { limit: 25 });

    expect(mockListDueCompletionPending).toHaveBeenCalledOnce();
    const opts = mockListDueCompletionPending.mock.calls[0]?.[2] as { limit: number };
    expect(opts.limit).toBe(25);
  });

  it('Plan 5.5a: zombie pending row (no task row) → clear pending + dispatchNextOrTerminate', async () => {
    // No task row matches (taskId, attempt). Pre-fix this
    // fell into the operation branch and bumped forever; now we treat it
    // as a zombie, clear the pending row, and trigger
    // dispatchNextOrTerminate so the run advances.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    mockListTaskRows.mockResolvedValue([]); // no row for our taskId/attempt
    mockClearCompletionPending.mockResolvedValueOnce(undefined);
    // dispatchNextOrTerminate setup.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
    mockLoadPendingWaiters.mockResolvedValue([]);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    expect(mockComputeReadyTasksWithWhen).toHaveBeenCalled();
    expect(result.zombies).toBe(1);
    expect(result.operationBumps).toBe(0);
    expect(result.orphans).toBe(0);
    expect(mockBumpCompletionPendingDueAt).not.toHaveBeenCalled();
  });

  it('Plan 5.5b: orphan-redispatch failure re-inserts pending row for retry', async () => {
    // recoverOrphanedTaskAttempt succeeds but dispatchNextOrTerminate
    // throws (e.g., transient DB blip). Without the durability fix the
    // run would be stuck — pending row gone, no future trigger. The
    // fix re-INSERTs the pending row so the next sweeper tick observes
    // a zombie and re-attempts dispatch.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow()]);
    setupAgentTaskRow();
    mockGetSessionState.mockResolvedValueOnce(null);
    mockRecoverOrphanedTaskAttempt.mockResolvedValueOnce(true);
    // After orphan recovery the next listTaskRows in dispatchNextOrTerminate
    // returns nothing (task row deleted); make resolveWorkflowForRunRevision
    // throw to simulate dispatch failure.
    mockResolveWorkflowForRunRevision.mockRejectedValueOnce(
      new Error('transient: workflow definition fetch failed'),
    );
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockAddCompletionPending.mockResolvedValueOnce(undefined);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    // Orphan was recovered.
    expect(mockRecoverOrphanedTaskAttempt).toHaveBeenCalledOnce();
    // Dispatch failed → durability path re-inserted the pending row.
    expect(mockAddCompletionPending).toHaveBeenCalledOnce();
    const reinsertArgs = mockAddCompletionPending.mock.calls[0]?.[2] as {
      runId: string;
      taskId: string;
      attempt: number;
      workerSessionId: string;
    };
    expect(reinsertArgs).toMatchObject({
      runId: RUN_ID,
      taskId: 'task-a',
      attempt: 1,
      workerSessionId: WORKER_SESSION_ID,
    });
    // The orphan still counts (recovery itself succeeded).
    expect(result.orphans).toBe(1);
  });

  it('does not escalate an operation task the executor still holds, however many bumps', async () => {
    mockGetStepInFlight.mockResolvedValueOnce({
      alive: true,
      deadlineAtMs: Date.now() + 3_600_000,
    });
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow({ attemptCount: 45 })]);
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({ taskId: 'task-a', attempt: 1, status: 'running', sessionId: null }),
    ]);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockGetStepInFlight).toHaveBeenCalledWith(deps.redis, WORKER_SESSION_ID);
    expect(result.escalations).toBe(0);
    expect(result.operationBumps).toBe(1);
  });

  it('Plan 5.5c: operation task with attemptCount ≥ threshold escalates to failed', async () => {
    // Crash window: claimAndSchedule landed but addStepJob never enqueued
    // (process crashed before post-claim catch ran). Task row is 'running'
    // with sessionId=NULL, no executor activity. After the bump threshold
    // the sweeper escalates to failed via applyFailureMode so the run
    // advances instead of bumping forever.
    mockListDueCompletionPending.mockResolvedValueOnce([
      buildPendingRow({ attemptCount: 30 }), // at threshold
    ]);
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({
        taskId: 'task-a',
        attempt: 1,
        status: 'running',
        sessionId: null, // operation task
        workerSessionId: WORKER_SESSION_ID,
      }),
    ]);
    mockCasCompleteTask.mockResolvedValueOnce(true);
    mockClearCompletionPending.mockResolvedValueOnce(undefined);
    // applyFailureMode setup.
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'test-skill',
        tasks: [{ taskId: 'task-a', name: 'A', goal: 'a', optional: false }],
      },
      source: 'revision',
    });
    mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
    mockLoadPendingWaiters.mockResolvedValue([]);
    mockLedgerCompleteRun.mockResolvedValue(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockCasCompleteTask).toHaveBeenCalledOnce();
    const casArgs = mockCasCompleteTask.mock.calls[0]?.[2] as {
      status: string;
      failureReason?: string;
    };
    expect(casArgs.status).toBe('failed');
    expect(casArgs.failureReason).toMatch(/Operation task stalled/);
    expect(mockClearCompletionPending).toHaveBeenCalledOnce();
    expect(result.escalations).toBe(1);
    expect(result.operationBumps).toBe(0);
  });

  it('Plan 5.5c: operation task below threshold still bumps (no premature escalation)', async () => {
    // attemptCount=10 is below the threshold (30), so the row should bump
    // normally. Verifies the escalation only fires for genuinely stalled
    // rows.
    mockListDueCompletionPending.mockResolvedValueOnce([buildPendingRow({ attemptCount: 10 })]);
    mockListTaskRows.mockResolvedValue([
      buildTaskRow({
        taskId: 'task-a',
        attempt: 1,
        status: 'running',
        sessionId: null,
        workerSessionId: WORKER_SESSION_ID,
      }),
    ]);
    mockBumpCompletionPendingDueAt.mockResolvedValueOnce(true);

    const result = await reconcileStaleRunForTenant(deps, TENANT);

    expect(mockCasCompleteTask).not.toHaveBeenCalled();
    expect(mockBumpCompletionPendingDueAt).toHaveBeenCalledOnce();
    expect(result.operationBumps).toBe(1);
    expect(result.escalations).toBe(0);
  });
});

describe('Plan 190 — live materialization in resolveWorkflowForRun', () => {
  const HELMSMAN_SESSION = '22222222-2222-2222-2222-222222222222';

  // The stored (un-derived) kaggle-style agent producer: closed output with
  // ONLY `runSummary`. `learnings` is absent — it is meant to be DERIVED from
  // the `workflow.learn` consumer at materialization.
  const STORED_EXTRACT_LEARNINGS = {
    taskId: 'extract-learnings',
    name: 'Extract Learnings',
    goal: 'Summarize the iteration and produce structured learnings for the next run.',
    type: 'agent' as const,
    dependsOn: ['execute'],
    outputContract: {
      schema: {
        type: 'object',
        required: ['runSummary'],
        additionalProperties: false,
        properties: { runSummary: { type: 'string', maxLength: 500 } },
      },
    },
  };

  // The downstream op task consumes `extract-learnings.output.learnings` into
  // `workflow.learn` — the op whose input schema the producer field is derived
  // from.
  const STORED_RECORD_LEARNINGS = {
    taskId: 'record-learnings',
    name: 'Record Learnings',
    goal: 'Persist the extracted learnings to the workflow ledger via workflow.learn.',
    type: 'operation' as const,
    operation: 'workflow.learn',
    dependsOn: ['extract-learnings'],
    inputBindings: {
      learnings: {
        kind: 'task_output' as const,
        taskId: 'extract-learnings',
        path: 'learnings',
      },
    },
  };

  function mockStoredKaggleStyleWorkflow(): void {
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'kaggle-style',
        tasks: [STORED_EXTRACT_LEARNINGS, STORED_RECORD_LEARNINGS],
        stateVariables: [],
      },
      source: 'revision',
    });
  }

  it('returns materialized tasks: the op-bound producer field is derived onto the stored agent contract', async () => {
    mockStoredKaggleStyleWorkflow();

    const resolved = await resolveWorkflowForRun(
      deps.db,
      TENANT,
      buildRunDetail([], 'running') as never,
    );

    expect(resolved).not.toBeNull();
    const extract = resolved?.tasks.find((t) => t.taskId === 'extract-learnings');
    const schema = extract?.outputContract?.schema as
      { properties?: Record<string, unknown>; required?: string[] } | undefined;

    // The derived field is present + required on the PRODUCER — the missing
    // piece a pre-fix install never persisted.
    expect(schema?.properties).toHaveProperty('learnings');
    expect(schema?.required).toContain('learnings');
    // The author-declared field is preserved (derivation augments, not replaces).
    expect(schema?.properties).toHaveProperty('runSummary');
  });

  it('downstream op dispatch resolves inputs against the materialized workflow (regression: existing-install heal)', async () => {
    mockStoredKaggleStyleWorkflow();
    mockLoadRunById.mockResolvedValue(buildRunDetail([], 'running'));
    mockClaimAndSchedule.mockResolvedValueOnce(true);
    mockGetSessionState.mockResolvedValue({});

    await dispatchTask(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      taskId: 'record-learnings',
      attempt: 1,
      helmsmanSessionId: HELMSMAN_SESSION as never,
    });

    // The run advanced: the op task claimed and ran inline (workflow.learn is
    // an inline, workflow-task-safe op) — no throw, no failure path.
    expect(mockClaimAndSchedule).toHaveBeenCalledOnce();
    expect(mockDispatchInlineOp).toHaveBeenCalledOnce();

    // The op task's input resolution (`buildTaskInputRef`) received the
    // MATERIALIZED workflow — its producer carries the derived `learnings`
    // contract the downstream op binds to. Pre-fix this resolved against the
    // raw snapshot, where `learnings` was absent.
    const buildCall = mockBuildTaskInputRef.mock.calls[0];
    expect(buildCall).toBeDefined();
    const passedWorkflow = buildCall?.[1] as {
      tasks: Array<{
        taskId: string;
        outputContract?: { schema?: { properties?: Record<string, unknown>; required?: string[] } };
      }>;
    };
    const producer = passedWorkflow.tasks.find((t) => t.taskId === 'extract-learnings');
    expect(producer?.outputContract?.schema?.properties).toHaveProperty('learnings');
    expect(producer?.outputContract?.schema?.required).toContain('learnings');
  });
});

describe('notifyWaiters — cancelled run pauses its parent for the user (Plan 211)', () => {
  const waiter = {
    id: 'waiter-211',
    waiterSessionId: '00000000-0000-0000-0000-0000000000d1',
    waiterStepExecutionId: '00000000-0000-0000-0000-0000000000e1',
  };
  const parkedStep = {
    stepId: 'dynamic_workflow_run_start_x',
    stepType: 'workflow',
    operationId: 'workflow.run.start',
    attempt: 1,
    traceId: 'trace-x',
    inputRef: 'inline:e30=',
    status: 'PAUSED',
  };

  function interruptPatch() {
    return mockUpdateSessionState.mock.calls
      .map((c) => c[3] as Record<string, unknown> | undefined)
      .find((p) => p && 'interruptRequested' in p);
  }
  function sessionResumedEvent() {
    return mockAppendSessionEvent.mock.calls
      .map((c) => c[3] as { eventType?: string } | undefined)
      .find((e) => e?.eventType === 'SessionResumed');
  }

  it('sets interruptRequested + records the cancellation tool result, with no SessionResumed', async () => {
    mockLoadPendingWaiters.mockResolvedValue([waiter]);
    mockGetStepState.mockResolvedValue(parkedStep);

    await notifyWaiters(deps, {
      tenantId: TENANT,
      runId: RUN_ID,
      outcome: 'cancelled',
      cancellation: { cancelledBy: 'agent', reason: 'replaced_by_new_run:test' },
    });

    // interruptRequested set → applyStepSucceeded's interrupt path pauses the
    // parent for the user instead of scheduling the next agent turn.
    expect(interruptPatch()).toMatchObject({
      interruptRequested: true,
      waitingOnWorkflowRunId: undefined,
    });
    // The cancellation tool result is still recorded (history coherence).
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    expect((mockAddStepResult.mock.calls[0]![1] as { status: string }).status).toBe('SUCCEEDED');
    // No resume — the session pauses, it does not wake into a turn.
    expect(sessionResumedEvent()).toBeUndefined();
    expect(mockMarkWaiterNotified).toHaveBeenCalledOnce();
  });

  it('completed still resumes the parent (no interruptRequested, SessionResumed emitted)', async () => {
    mockLoadPendingWaiters.mockResolvedValue([waiter]);
    mockGetStepState.mockResolvedValue(parkedStep);

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN_ID, outcome: 'completed' });

    expect(interruptPatch()).toBeUndefined();
    expect(sessionResumedEvent()).toBeDefined();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
  });
});
