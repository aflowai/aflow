import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockListActiveRunsForWorkflow = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockMaterializeAndValidateSkillConfig = vi.fn();
const mockMaybeTriggerValidityRepairReview = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: vi.fn(),
  loadPendingWaiters: vi.fn(),
  listPendingAttention: vi.fn(),
  surfaceWorkflowResumeContract: vi.fn(),
  cancelNonTerminalTasksForRun: vi.fn(),
  listCompletionPendingForRun: vi.fn(),
  clearAllCompletionPendingForRun: vi.fn(),
  completeRun: vi.fn(),
  addAttentionItem: vi.fn(),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  recoverStalledRun: vi.fn(),
  recordTaskResult: vi.fn(),
  updateRunMetadata: vi.fn(),
  recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
  resolveSkillForWorkflow: vi.fn().mockResolvedValue(null),
  listCampaigns: vi.fn().mockResolvedValue([]),
  ensureActiveCampaign: vi.fn(),
  selectCampaignForRunStart: vi.fn(),
  buildCampaignRequiredErrorDetails: vi.fn(),
  materializeAndValidateSkillConfig: (...args: unknown[]) =>
    mockMaterializeAndValidateSkillConfig(...args),
  maybeTriggerValidityRepairReview: (...args: unknown[]) =>
    mockMaybeTriggerValidityRepairReview(...args),
  renderSkillDiagnostics: () => 'rendered-diagnostics',
  hashWorkflowConfig: () => 'mock-artifact-hash',
  WorkflowArchivedError: class extends Error {},
  isCyberneticSpace: vi.fn().mockResolvedValue(false),
  cyberneticHookSafe: vi.fn(),
  triggerCoachReview: vi.fn(),
  runEvaluation: vi.fn(),
  listActiveRuns: vi.fn(),
  listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
  listActiveRunsForWorkflowWithLiveness: (...args: unknown[]) =>
    mockListActiveRunsForWorkflow(...args),
  deriveRunLivenessFromCounts: () => 'executing',
  listRecentRuns: vi.fn().mockResolvedValue([]),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  onSkillRunCompleted: vi.fn(),
  validateWorkflowGraph: vi.fn(),
  patchTouchesGraph: vi.fn(),
  deriveRunLiveness: vi.fn(),
  claimResumeLease: vi.fn(),
  releaseResumeClaim: vi.fn(),
  resumeRunWithClaim: vi.fn(),
  bumpResumeAttemptCount: vi.fn(),
  commitReplaceOutputAndResume: vi.fn(),
  addWaiter: vi.fn().mockResolvedValue(undefined),
  markWaiterNotified: vi.fn(),
  computeReadyTasksWithWhen: vi.fn().mockReturnValue({ ready: [], skipped: [], errors: [] }),
  claimAndSchedule: vi.fn(),
  claimHumanTask: vi.fn(),
  casCompleteTask: vi.fn(),
  clearCompletionPending: vi.fn(),
  recordTaskSkipped: vi.fn(),
  blockDescendantTasks: vi.fn(),
  computeDescendants: vi.fn(),
}));

const mockResolveWorkflowForStart = vi.fn();
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      ensureParentDirs: vi.fn(),
      mkdir: vi.fn(),
    })),
    resolveWorkflowForRunRevision: vi.fn(),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df' }]),
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      }),
    ),
    workflowDirPath: (slug: string) => `/workflows/${slug}`,
    workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
    ensureWorkflowRevisionSnapshot: vi.fn(),
    resolveWorkflowForStart: (...args: unknown[]) => mockResolveWorkflowForStart(...args),
    listWorkflowsWithPlatform: vi.fn(),
  };
});

vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: vi.fn().mockResolvedValue({ ok: true }),
  checkWorkflowCapabilityPreflight: vi.fn().mockResolvedValue({ ok: true }),
  toBlockedBindingsForResumeContract: vi.fn((x: unknown) => x),
  renderPreflightFailureMessage: vi.fn(),
}));

vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  cancelRun: vi.fn(),
  startRun: vi.fn().mockResolvedValue({ activeTasks: [] }),
}));

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addControlMessage: vi.fn(),
  getSessionState: vi.fn().mockResolvedValue(null),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const SESSION_RUN_ID = '99999999-2222-3333-4444-555555555555';
const SLUG = 'lead-scoring';

const DIAGNOSTICS = [
  {
    code: 'op_input_missing_required',
    dimension: 'op_input',
    severity: 'error',
    taskId: 'task-a',
    field: 'kind',
    detail: "Required input 'kind' is not bound and has no default.",
    fixHint: "Bind 'kind' from an upstream output or add a literal value.",
  },
];

function makeStartArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockImplementation((ref: string) => {
        if (ref === inputRef) return Promise.resolve(input);
        return Promise.resolve(null);
      }),
      store: vi.fn().mockResolvedValue('inline:stored='),
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION_RUN_ID,
      traceId: 'trace-1',
      spaceId: SPACE,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'wf_op',
      stepType: 'workflow',
      operation: 'workflow.run.start',
      tags: [],
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function approvedWorkflow() {
  return {
    slug: SLUG,
    revision: 1,
    status: 'approved',
    tasks: [{ taskId: 'task-a', name: 'A', goal: 'g' }],
    budget: undefined,
  };
}

function invalidVerdict() {
  return {
    materializedTasks: [],
    validity: {
      status: 'invalid',
      diagnostics: DIAGNOSTICS,
      advisories: [],
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function validVerdict(input: { tasks: unknown[] }) {
  return {
    materializedTasks: input.tasks,
    validity: {
      status: 'valid',
      diagnostics: [],
      advisories: [],
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveWorkflowForStart.mockResolvedValue(approvedWorkflow());
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockMaterializeAndValidateSkillConfig.mockImplementation((input: { tasks: unknown[] }) =>
    validVerdict(input),
  );
  mockMaybeTriggerValidityRepairReview.mockResolvedValue(null);
});

function decodeError(call: { errorRef: string }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(call.errorRef.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('workflow.run.start — validity gate → repair trigger (Plan 183g seam 1)', () => {
  it('routes the verdict diagnostics to maybeTriggerValidityRepairReview after the SKILL_CONTRACT_INVALID rejection', async () => {
    mockMaterializeAndValidateSkillConfig.mockReturnValue(invalidVerdict());

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    // (a) The rejection unblocked the Helmsman: exactly one FAILED step
    // result, typed, with the diagnostics in error.details.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('SKILL_CONTRACT_INVALID');
    expect(error['classification']).toBe('validation');
    expect((error['details'] as Record<string, unknown>)['diagnostics']).toEqual(DIAGNOSTICS);

    // (b) Exactly one activation attempt, carrying the verdict's diagnostics
    // (not a re-derived set) and anchored on the blocked Helmsman session.
    expect(mockMaybeTriggerValidityRepairReview).toHaveBeenCalledOnce();
    const params = mockMaybeTriggerValidityRepairReview.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(params['tenantId']).toBe(TENANT);
    expect(params['spaceId']).toBe(SPACE);
    expect(params['workflowSlug']).toBe(SLUG);
    expect(params['diagnostics']).toEqual(DIAGNOSTICS);
    expect(params['anchorRunId']).toBe(SESSION_RUN_ID);

    // Rejection first, trigger second (best-effort tail).
    const emitOrder = mockAddStepResult.mock.invocationCallOrder[0]!;
    const triggerOrder = mockMaybeTriggerValidityRepairReview.mock.invocationCallOrder[0]!;
    expect(emitOrder).toBeLessThan(triggerOrder);

    // The run never started.
    expect(mockRecordRunStart).not.toHaveBeenCalled();
  });

  it('does NOT fire the repair trigger on the valid path', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockMaybeTriggerValidityRepairReview).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it('contains a throwing trigger — the typed rejection stands alone, no second step error', async () => {
    mockMaterializeAndValidateSkillConfig.mockReturnValue(invalidVerdict());
    mockMaybeTriggerValidityRepairReview.mockRejectedValue(new Error('redis ECONNRESET'));

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockMaybeTriggerValidityRepairReview).toHaveBeenCalledOnce();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const error = decodeError(
      mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string },
    );
    expect(error['code']).toBe('SKILL_CONTRACT_INVALID');
    expect(mockRecordRunStart).not.toHaveBeenCalled();
  });
});
