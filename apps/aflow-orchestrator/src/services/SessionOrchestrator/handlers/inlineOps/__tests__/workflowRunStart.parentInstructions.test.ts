import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockListActiveRunsForWorkflow = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockCancelRun = vi.fn();

const provenance = () => ({
  contractValidity: {
    status: 'valid',
    artifactHash: expect.any(String),
    validatedAt: expect.any(String),
  },
});

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
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
  };
});

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
  cancelRun: (...args: unknown[]) => mockCancelRun(...args),
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

function approvedWorkflow(overrides?: { tasks?: Array<Record<string, unknown>> }) {
  return {
    slug: 'bind-capability',
    revision: 1,
    status: 'approved',
    tasks: overrides?.tasks ?? [
      { taskId: 'elicit-target', name: 'Elicit', goal: 'g', type: 'agent' },
    ],
    budget: undefined,
  };
}

function decodeError(call: { errorRef: string }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(call.errorRef.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveWorkflowForStart.mockResolvedValue(approvedWorkflow());
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
});

describe('workflow.run.start — Plan 141 parent instructions storage', () => {
  it('no instructions: metadata carries only contract provenance', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'bind-capability' }));
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    // No parentInstructions/parentTaskInputs keys — only the always-on Slice 5b
    // provenance.
    expect(params['metadata']).toEqual(provenance());
  });

  it('run-level string: stored as { parentInstructions: { runLevel } }', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'bind-capability', instructions: 'bind Alpaca paper' }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentInstructions: { runLevel: 'bind Alpaca paper' },
    });
  });

  it('task-targeted array: stored as { parentInstructions: { taskTargeted } }', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          { taskId: 'elicit-target', name: 'Elicit', goal: 'g', type: 'agent' },
          {
            taskId: 'confirm-bind',
            name: 'Confirm',
            goal: 'g',
            type: 'agent',
            dependsOn: ['elicit-target'],
          },
        ],
      }),
    );
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: [
          { taskId: 'elicit-target', text: 'vendor=Alpaca' },
          { taskId: 'confirm-bind', text: 'use paper baseUrl' },
        ],
      }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentInstructions: {
        taskTargeted: [
          { taskId: 'elicit-target', text: 'vendor=Alpaca' },
          { taskId: 'confirm-bind', text: 'use paper baseUrl' },
        ],
      },
    });
  });

  it('single-entry task-targeted: writes the single-element array verbatim', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
      }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentInstructions: {
        taskTargeted: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
      },
    });
  });
});

describe('workflow.run.start — instruction target validation', () => {
  it('rejects an instruction addressed to a non-existent taskId with a teaching error and no run row', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: [{ taskId: 'explore-data', text: 'the operator brief' }],
      }),
    );
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('INSTRUCTION_TARGETS_INVALID');
    const message = error['message'] as string;
    expect(message).toContain('explore-data');
    expect(message).toContain('elicit-target');
    const details = error['details'] as Record<string, unknown>;
    expect(details['unknownTaskIds']).toEqual(['explore-data']);
    expect(details['agentTaskIds']).toEqual(['elicit-target']);
  });

  it('rejects an instruction addressed to an existing non-agent task, listing the agent task ids', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          { taskId: 'elicit-target', name: 'Elicit', goal: 'g', type: 'agent' },
          {
            taskId: 'approve-submit',
            name: 'Approve',
            goal: 'g',
            type: 'human',
            pauseInstruction: 'Approve the submission',
            dependsOn: ['elicit-target'],
          },
        ],
      }),
    );
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: [{ taskId: 'approve-submit', text: 'approve only if score improves' }],
      }),
    );
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('INSTRUCTION_TARGETS_INVALID');
    const message = error['message'] as string;
    expect(message).toContain('approve-submit');
    expect(message).toContain('elicit-target');
    const details = error['details'] as Record<string, unknown>;
    expect(details['nonAgentTaskIds']).toEqual(['approve-submit']);
    expect(details['agentTaskIds']).toEqual(['elicit-target']);
  });

  it('an instruction addressed to a real agent task still starts the run', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
      }),
    );
    expect(mockAddStepResult).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'FAILED' }),
      expect.anything(),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });
});

describe('workflow.run.start — Plan 141 §4.2 typed parent inputs', () => {
  it('no inputs: metadata carries no parentTaskInputs (only provenance)', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'bind-capability' }));
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual(provenance());
  });

  it('catch-all path: workflow with no inputContract on first task accepts inputs verbatim', async () => {
    // Default approvedWorkflow first task has no inputContract.
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
      }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentTaskInputs: {
        taskId: 'elicit-target',
        inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
      },
    });
  });

  it('strict path: validates inputs against inputContract.bindings[bindAs].schema', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          {
            taskId: 'elicit-target',
            name: 'Elicit',
            goal: 'g',
            inputContract: {
              bindings: {
                vendor: {
                  kind: 'run_input',
                  bindAs: 'vendor',
                  path: 'vendor',
                  schema: { type: 'string', minLength: 3 },
                },
              },
            },
          },
        ],
      }),
    );

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'bind-capability', inputs: { vendor: 'Alpaca' } }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentTaskInputs: { taskId: 'elicit-target', inputs: { vendor: 'Alpaca' } },
    });
  });

  it('strict path: rejects PARENT_INPUTS_INVALID on schema violation with structured details', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          {
            taskId: 'elicit-target',
            name: 'Elicit',
            goal: 'g',
            inputContract: {
              bindings: {
                vendor: {
                  kind: 'run_input',
                  bindAs: 'vendor',
                  path: 'vendor',
                  schema: { type: 'string', minLength: 5 },
                },
              },
            },
          },
        ],
      }),
    );

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'bind-capability', inputs: { vendor: 'ab' } }),
    );

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('PARENT_INPUTS_INVALID');
    const details = error['details'] as Record<string, unknown>;
    expect(details['firstTaskId']).toBe('elicit-target');
    expect(details['populatableBindAs']).toEqual(['vendor']);
    const issues = details['issues'] as Array<Record<string, unknown>>;
    expect(issues[0]!['code']).toBe('SCHEMA_VIOLATION');
    expect(issues[0]!['bindAs']).toBe('vendor');
  });

  it('strict path: rejects UNKNOWN_BINDAS for keys not declared on the first task', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          {
            taskId: 'elicit-target',
            name: 'Elicit',
            goal: 'g',
            inputContract: {
              bindings: {
                vendor: {
                  kind: 'run_input',
                  bindAs: 'vendor',
                  path: 'vendor',
                  schema: { type: 'string' },
                },
              },
            },
          },
        ],
      }),
    );

    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        inputs: { vendor: 'Alpaca', wat: 'unknown' },
      }),
    );
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('PARENT_INPUTS_INVALID');
    const issues = (error['details'] as Record<string, unknown>)['issues'] as Array<
      Record<string, unknown>
    >;
    expect(issues.find((i) => i['code'] === 'UNKNOWN_BINDAS')).toBeDefined();
  });

  it('rejects multiple root tasks at skill validity check (SKILL_CONTRACT_INVALID / multiple_root_tasks)', async () => {
    // Multiple root tasks are now caught by validateWorkflowGraph (multiple_root_tasks
    // diagnostic) during materializeAndValidateSkillConfig — before selectFirstTaskForParentInputs
    // is reached. The run is rejected with SKILL_CONTRACT_INVALID, not AMBIGUOUS_ROOT_TASKS.
    mockResolveWorkflowForStart.mockResolvedValueOnce(
      approvedWorkflow({
        tasks: [
          { taskId: 'a', name: 'A', goal: 'g' },
          { taskId: 'b', name: 'B', goal: 'g' },
        ],
      }),
    );
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'bind-capability', inputs: { x: 1 } }));
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    const error = decodeError(result);
    expect(error['code']).toBe('SKILL_CONTRACT_INVALID');
    const details = error['details'] as Record<string, unknown>;
    const diagnostics = details['diagnostics'] as Array<{ code: string }>;
    expect(diagnostics.some((d) => d.code === 'multiple_root_tasks')).toBe(true);
  });

  it('empty inputs object: treated as absent (no parentTaskInputs key written)', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'bind-capability', inputs: {} }));
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual(provenance());
  });

  it('inputs + instructions coexist: both keys land on metadata', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({
        slug: 'bind-capability',
        instructions: 'use paper baseUrl',
        inputs: { vendor: 'Alpaca' },
      }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentInstructions: { runLevel: 'use paper baseUrl' },
      parentTaskInputs: {
        taskId: 'elicit-target',
        inputs: { vendor: 'Alpaca' },
      },
    });
  });
});

describe('workflow.run.start — fail-fast on a missing required run input', () => {
  // The literature-scan shape: the entry task declares its run inputs via
  // `inputBindings` (kind run_input) and the workflow declares `runInputs`
  // (topic required, focus optional). NO hand-authored inputContract.
  function literatureScanLike(): Record<string, unknown> {
    return {
      slug: 'literature-scan',
      revision: 1,
      status: 'approved',
      runInputs: [
        { id: 'topic', required: true, schema: { type: 'string', minLength: 1 } },
        { id: 'focus', required: false },
      ],
      tasks: [
        {
          taskId: 'gather-papers',
          name: 'Gather papers',
          goal: 'g',
          type: 'agent',
          inputBindings: {
            topic: { kind: 'run_input', path: 'topic' },
            focus: { kind: 'run_input', path: 'focus' },
          },
        },
      ],
      budget: undefined,
    };
  }

  it('rejects a start with NO inputs when a required run input is declared (inputBindings-only)', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(literatureScanLike());
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'literature-scan' }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('PARENT_INPUTS_INVALID');
    expect(String(error['message'])).toContain('topic');
    const details = error['details'] as Record<string, unknown>;
    const issues = details['issues'] as Array<Record<string, unknown>>;
    expect(issues.some((i) => i['bindAs'] === 'topic' && i['code'] === 'MISSING_BINDAS')).toBe(
      true,
    );
    // focus is optional — must NOT be reported missing.
    expect(issues.some((i) => i['bindAs'] === 'focus')).toBe(false);
  });

  it('rejects when the topic is passed as free-form instructions instead of inputs', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(literatureScanLike());
    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'literature-scan', instructions: 'topic: diffusion models' }),
    );
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(decodeError(result)['code']).toBe('PARENT_INPUTS_INVALID');
  });

  it('proceeds when the required run input is provided (optional omitted)', async () => {
    mockResolveWorkflowForStart.mockResolvedValueOnce(literatureScanLike());
    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'literature-scan', inputs: { topic: 'diffusion models' } }),
    );
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual({
      ...provenance(),
      parentTaskInputs: { taskId: 'gather-papers', inputs: { topic: 'diffusion models' } },
    });
  });

  it('proceeds when a workflow declares only OPTIONAL run inputs and none are passed', async () => {
    const optionalOnly = literatureScanLike();
    optionalOnly['runInputs'] = [{ id: 'topic', required: false }];
    mockResolveWorkflowForStart.mockResolvedValueOnce(optionalOnly);
    await handleWorkflowCrudInline(makeStartArgs({ slug: 'literature-scan' }));
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['metadata']).toEqual(provenance());
  });
});
