import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRevisionDriftError } from '@aflow/database';
import type { InlineHandlerArgs } from '../types.js';

const mockRecordRunStart = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
  listActiveRunsForWorkflowWithLiveness: vi.fn().mockResolvedValue([]),
  deriveRunLivenessFromCounts: vi.fn().mockReturnValue('executing'),
  listRecentRuns: vi.fn().mockResolvedValue([]),
  getRunStatistics: vi.fn().mockResolvedValue({ totalRuns: 0 }),
  resolveSkillForWorkflow: vi.fn().mockResolvedValue(null),
  listCampaigns: vi.fn().mockResolvedValue([]),
  ensureActiveCampaign: vi.fn(),
  selectCampaignForRunStart: vi.fn(),
  buildCampaignRequiredErrorDetails: vi.fn(),
  describeCampaignContractFields: vi.fn(),
  resolveConnectionForRepoCoordinate: vi.fn(),
  RepoConnectionResolveError: class extends Error {},
  findUnpinnedGithubApiTasks: vi.fn().mockReturnValue([]),
  selectFirstTaskForParentInputs: vi.fn(),
  validateParentTaskInputs: vi.fn(),
  renderParentInputsValidationFailure: vi.fn(),
  materializeAndValidateSkillConfig: (input: { tasks: unknown[] }) => ({
    materializedTasks: input.tasks,
    validity: {
      status: 'valid',
      diagnostics: [],
      advisories: [],
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  maybeTriggerValidityRepairReview: vi.fn(),
  renderSkillDiagnostics: () => '',
  hashWorkflowConfig: () => 'mock-artifact-hash',
  WorkflowArchivedError: class extends Error {},
}));

const mockResolveWorkflowForStart = vi.fn();
const mockEnsureWorkflowRevisionSnapshot = vi.fn();
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
    workflowDirPath: (slug: string) => `/workflows/${slug}`,
    workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
    ensureWorkflowRevisionSnapshot: (...args: unknown[]) =>
      mockEnsureWorkflowRevisionSnapshot(...args),
    resolveWorkflowForStart: (...args: unknown[]) => mockResolveWorkflowForStart(...args),
  };
});

vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: vi.fn().mockResolvedValue({ ok: true }),
  checkWorkflowCapabilityPreflight: vi.fn().mockResolvedValue({ ok: true }),
  toBlockedBindingsForResumeContract: vi.fn((x: unknown) => x),
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

function decodeError(call: { errorRef: string }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(call.errorRef.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveWorkflowForStart.mockResolvedValue({
    slug: 'lead-scoring',
    revision: 3,
    status: 'approved',
    origin: 'tenant',
    tasks: [{ taskId: 'task-a', name: 'A', goal: 'g' }],
    budget: undefined,
  });
});

describe('workflow.run.start — revision drift legibility', () => {
  it('emits structured WORKFLOW_REVISION_DRIFT (validation, non-retryable) instead of the generic internal error', async () => {
    mockEnsureWorkflowRevisionSnapshot.mockRejectedValueOnce(
      new WorkflowRevisionDriftError(
        'lead-scoring',
        3,
        'In-memory workflow definition at this revision differs from the persisted snapshot.',
      ),
    );

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('WORKFLOW_REVISION_DRIFT');
    expect(error['classification']).toBe('validation');
    expect(error['retryable']).toBe(false);
    expect(error['message']).toContain('lead-scoring');
    expect(error['message']).toContain('revision 3');
    // The drift error must NOT steer the agent into a destructive full re-put:
    // that re-validates the whole graph and can spiral into rewriting tasks.
    expect(error['message']).not.toContain('workflow.manage.put');
    const message = String(error['message']);
    expect(message.toLowerCase()).toContain('operator');
    expect(message).toMatch(/do not|don't/i);
    expect(message).toMatch(/re-?put|rewrite/i);
    expect(error['details']).toEqual({ slug: 'lead-scoring', revision: 3 });
  });

  it('still routes non-drift snapshot failures through the generic internal catch', async () => {
    mockEnsureWorkflowRevisionSnapshot.mockRejectedValueOnce(new Error('db connection reset'));

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const error = decodeError(mockAddStepResult.mock.calls[0]![1] as { errorRef: string });
    expect(error['code']).toBe('WORKFLOW_OPERATION_FAILED');
    expect(error['classification']).toBe('internal');
  });
});
