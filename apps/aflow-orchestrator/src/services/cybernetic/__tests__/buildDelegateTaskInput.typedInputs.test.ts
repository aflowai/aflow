import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadRunById = vi.fn();
const mockBuildRunnerDelegationContext = vi.fn();
const mockResolveRunnerModelHot = vi.fn();
const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
  resolveWorkflowForRunRevision: vi.fn(),
  MissingPinnedRevisionError: class extends Error {},
  workflowRoot: () => '/workflows',
  workflowDirPath: (slug: string) => `/workflows/${slug}`,
  workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
  workflowRevisionPath: (slug: string, r: number) =>
    `/workflows/${slug}/revisions/workflow-r${String(r)}.json`,
  ensureWorkflowRevisionSnapshot: async () => 'created' as const,
  createMemoryDocRepository: vi.fn(),
  createMemoryDirRepository: vi.fn(),
}));

vi.mock('@aflow/redis', () => ({
  addStepResult: vi.fn(),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
}));

vi.mock('@aflow/cybernetic-runtime', async () => {
  const { readOutputPath } = await vi.importActual<
    typeof import('@aflow/cybernetic-runtime/scheduling/output-path')
  >('@aflow/cybernetic-runtime/scheduling/output-path');
  return {
    readOutputPath,
    buildRunnerDelegationContext: (...args: unknown[]) => mockBuildRunnerDelegationContext(...args),
    recordRunStart: vi.fn(),
    recordTaskSkipped: vi.fn(),
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    listActiveRunsForWorkflow: vi.fn(),
    listRecentRuns: vi.fn(),
    getRunStatistics: vi.fn(),
    completeRun: vi.fn(),
    computeReadyTasksWithWhen: vi.fn(),
    deriveRunLiveness: vi.fn(),
    recoverStalledRun: vi.fn(),
    resolveRunnerModelHot: (...args: unknown[]) => mockResolveRunnerModelHot(...args),
    resolveRunnerReasoningHot: vi.fn().mockResolvedValue(undefined),
    deriveEffectiveOutputSchema: vi.fn(),
    DeriveSchemaError: class extends Error {},
  };
});

vi.mock('@aflow/platform-artifacts', () => ({
  getPlatformWorkflow: vi.fn(),
}));

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN = 'run-typedinputs-1';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

const baseWdc = {
  runnerModel: 'sonnet',
  runnerSystemPrompt: 'system prompt',
  runnerTools: ['t1'],
  taskContext: 'ctx',
  taskLearnings: 'learn',
};

const baseAgentTask = {
  taskId: 'analyze-intent',
  name: 'Analyze',
  goal: 'analyze',
  type: 'agent' as const,
} as never;

const baseWorkflow = {
  slug: 'compose-skill',
  assignedAgent: 'cybernetic-runner',
} as never;

describe('buildDelegateTaskInput — Plan 123 typed-input channel (always-on)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRunnerModelHot.mockResolvedValue('sonnet');
  });

  it('agent task with bindings: delegate input carries runner_task_inputs + TASK INPUTS prompt block', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: RUN,
      tasks: [
        {
          taskId: 'upstream',
          status: 'succeeded',
          outputRef: inlineRef({ childOutput: { intent: 'X', iterationModel: 'process' } }),
        },
      ],
    });
    mockBuildRunnerDelegationContext.mockImplementation(
      (params: { taskInputs?: Record<string, unknown> }) => ({
        ...baseWdc,
        ...(params.taskInputs ? { taskInputs: params.taskInputs } : {}),
      }),
    );

    const taskWithBinding = {
      ...baseAgentTask,
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'upstream', path: 'intent' },
      },
    } as never;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      taskWithBinding,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
    );
    expect(delegate.config['runner_task_inputs']).toEqual({ intent: 'X' });
    expect(delegate.input).toContain('TASK INPUTS (typed, keyed by bindAs):');
    expect(delegate.input).not.toContain('PRIOR TASK RESULTS:');
  });

  it('agent task with no bindings: still emits empty runner_task_inputs and the TASK INPUTS block', async () => {
    mockLoadRunById.mockResolvedValue({ runId: RUN, tasks: [] });
    mockBuildRunnerDelegationContext.mockImplementation(
      (params: { taskInputs?: Record<string, unknown> }) => ({
        ...baseWdc,
        ...(params.taskInputs ? { taskInputs: params.taskInputs } : {}),
      }),
    );

    const taskNoBindings = baseAgentTask;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(taskNoBindings, baseWorkflow, TENANT, SPACE, RUN);
    // Always-present typed contract: empty object, not undefined.
    expect(delegate.config['runner_task_inputs']).toEqual({});
    expect(delegate.input).toContain('TASK INPUTS (typed, keyed by bindAs):');
    expect(delegate.input).not.toContain('PRIOR TASK RESULTS:');
  });

  it('input-resolution failure fail-closes: rethrows rather than degrading to prose', async () => {
    // loadRunById returns a run, but the task references a missing
    // upstream so resolveTaskInputs throws TaskInputResolutionError.
    mockLoadRunById.mockResolvedValue({ runId: RUN, tasks: [] });

    const taskWithBindingToMissing = {
      ...baseAgentTask,
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'does-not-exist' },
      },
    } as never;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    await expect(
      buildDelegateTaskInput(taskWithBindingToMissing, baseWorkflow, TENANT, SPACE, RUN),
    ).rejects.toThrow(/does not exist in run/);
  });
});

describe('buildDelegateTaskInput — assembled context reaches the Runner prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRunnerModelHot.mockResolvedValue('sonnet');
  });

  it('non-empty taskContext + taskLearnings: prompt carries both blocks before TASK INPUTS', async () => {
    mockBuildRunnerDelegationContext.mockImplementation(() => ({
      ...baseWdc,
      taskContext: '--- /coach/strategy.md ---\nprefer gradient boosting',
      taskLearnings:
        '- [trajectory] objective: minimize rmsle; peak so far: 0.128\n- [worked] log-transform target → keep it',
    }));

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(baseAgentTask, baseWorkflow, TENANT, SPACE, RUN);
    const prompt = delegate.input;
    expect(prompt).toContain(
      'CONTEXT DOCUMENTS:\n--- /coach/strategy.md ---\nprefer gradient boosting',
    );
    expect(prompt).toContain('PRIOR LEARNINGS:\n- [trajectory] objective: minimize rmsle');
    expect(prompt).toContain('log-transform target → keep it');
    const contextIdx = prompt.indexOf('CONTEXT DOCUMENTS:');
    const learningsIdx = prompt.indexOf('PRIOR LEARNINGS:');
    const taskInputsIdx = prompt.indexOf('TASK INPUTS (typed, keyed by bindAs):');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(learningsIdx).toBeGreaterThan(contextIdx);
    expect(taskInputsIdx).toBeGreaterThan(learningsIdx);
  });

  it('empty taskContext + taskLearnings: prompt has neither block', async () => {
    mockBuildRunnerDelegationContext.mockImplementation(() => ({
      ...baseWdc,
      taskContext: '',
      taskLearnings: '',
    }));

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(baseAgentTask, baseWorkflow, TENANT, SPACE, RUN);
    expect(delegate.input).not.toContain('CONTEXT DOCUMENTS:');
    expect(delegate.input).not.toContain('PRIOR LEARNINGS:');
  });
});

describe('buildDelegateTaskInput — the delegate input is a value, never a stored payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRunnerModelHot.mockResolvedValue('sonnet');
  });

  it('oversized delegate input: returned in full, no payload-store write', async () => {
    mockBuildRunnerDelegationContext.mockImplementation(() => ({
      ...baseWdc,
      taskContext: 'x'.repeat(80 * 1024),
    }));
    const store = vi.fn();
    const payloadStore = { store } as never;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      payloadStore,
    );

    // Spilling happens at the dispatch encode of `{ input, config }` —
    // the envelope itself must never be stored (a stored envelope would
    // be read back once and orphaned).
    expect(store).not.toHaveBeenCalled();
    expect(delegate.input).toContain('CONTEXT DOCUMENTS:');
    expect(delegate.displayMeta).toEqual({
      workflowSlug: 'compose-skill',
      taskId: 'analyze-intent',
      taskName: 'Analyze',
    });
  });
});
