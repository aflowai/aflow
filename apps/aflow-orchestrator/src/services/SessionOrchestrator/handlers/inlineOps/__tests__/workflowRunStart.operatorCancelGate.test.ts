import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockListActiveRunsForWorkflow = vi.fn();
const mockListRecentRuns = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockResolveSkillForWorkflow = vi.fn();

const { SkillConcurrencyPolicySchema } = await vi.hoisted(() => import('@aflow/schemas'));

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
  resolveSkillForWorkflow: (...args: unknown[]) => mockResolveSkillForWorkflow(...args),
  resolveEffectiveConcurrencyPolicy: (policy: unknown) =>
    SkillConcurrencyPolicySchema.parse(policy ?? {}),
  listCampaigns: vi.fn().mockResolvedValue([]),
  ensureActiveCampaign: vi.fn(),
  selectCampaignForRunStart: vi.fn(),
  buildCampaignRequiredErrorDetails: vi.fn(),
  materializeAndValidateSkillConfig: (input: { tasks: unknown[] }) => ({
    materializedTasks: input.tasks,
    validity: {
      status: 'valid',
      diagnostics: [],
      advisories: [],
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  renderSkillDiagnostics: () => '',
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
  listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  onSkillRunCompleted: vi.fn(),
  validateWorkflowGraph: vi.fn(),
  patchTouchesGraph: vi.fn(),
  deriveRunLiveness: vi.fn(),
  addWaiter: vi.fn().mockResolvedValue(undefined),
  markWaiterNotified: vi.fn(),
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
    slug: 'kaggle-competition-optimizer',
    revision: 1,
    status: 'approved',
    tasks: [{ taskId: 'task-a', name: 'A', goal: 'g' }],
    budget: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drain `mockResolvedValueOnce` queues; the ack=true
  // case skips the lookup so its queued value would otherwise leak forward.
  mockListRecentRuns.mockReset();
  mockResolveWorkflowForStart.mockResolvedValue(approvedWorkflow());
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
  mockListRecentRuns.mockResolvedValue([]);
  // Default: a campaign-contracted skill, so the operator-cancel gate is active.
  // (No numeric goal → the downstream campaign-resolution block is skipped, so
  // these gate tests don't need the full campaign-selection mock surface.)
  mockResolveSkillForWorkflow.mockResolvedValue({
    manifest: { campaign: { fields: { slug: {} } } },
  });
});

function decodeError(call: { errorRef: string }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(call.errorRef.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('workflow.run.start — operator-cancel STOP gate', () => {
  const lastRunId = 'dddddddd-1111-1111-1111-111111111111';

  it('refuses a fresh start when the most recent run was operator-cancelled', async () => {
    mockListRecentRuns.mockResolvedValueOnce([
      {
        runId: lastRunId,
        status: 'cancelled',
        cancelledBy: 'operator',
        cancelReason: 'changed my mind',
      },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'kaggle-competition-optimizer' }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('OPERATOR_CANCEL_RESTART_BLOCKED');
    expect(error['classification']).toBe('validation');
    const details = error['details'] as Record<string, unknown>;
    expect(details['lastRunId']).toBe(lastRunId);
    expect(details['cancelledBy']).toBe('operator');
    expect(details['cancelReason']).toBe('changed my mind');
  });

  it('allows the start when acknowledgeOperatorCancel is set (explicit user instruction)', async () => {
    mockListRecentRuns.mockResolvedValueOnce([
      { runId: lastRunId, status: 'cancelled', cancelledBy: 'operator', cancelReason: null },
    ]);

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'kaggle-competition-optimizer', acknowledgeOperatorCancel: true }),
    );

    // Gate skipped → the recent-runs lookup never even fires.
    expect(mockListRecentRuns).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it('does NOT block when the most recent run was agent-cancelled (e.g. replace_active)', async () => {
    mockListRecentRuns.mockResolvedValueOnce([
      {
        runId: lastRunId,
        status: 'cancelled',
        cancelledBy: 'agent',
        cancelReason: 'replaced_by_new_run',
      },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'kaggle-competition-optimizer' }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it('does NOT block when the most recent run completed normally', async () => {
    mockListRecentRuns.mockResolvedValueOnce([
      { runId: lastRunId, status: 'completed', cancelledBy: null, cancelReason: null },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'kaggle-competition-optimizer' }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it('does NOT gate a non-campaign meta-workflow even after an operator cancel (Plan 206/182)', async () => {
    // compose-skill / bind-capability have no campaign contract — each run is an
    // independent invocation, so a prior operator cancel must not block the next.
    mockResolveSkillForWorkflow.mockResolvedValueOnce(null);
    mockListRecentRuns.mockResolvedValueOnce([
      { runId: lastRunId, status: 'cancelled', cancelledBy: 'operator', cancelReason: 'stopped' },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'compose-skill' }));

    // Gate skipped (no campaign) → the recent-runs lookup never fires, run starts.
    expect(mockListRecentRuns).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });
});
