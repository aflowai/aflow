import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadRunById = vi.fn();
const mockSelectActiveLearningSetForRun = vi.fn();
const mockGetRunCampaignId = vi.fn();
const mockGetCampaignById = vi.fn();

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
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', async () => {
  const [{ readOutputPath, parseOutputPath }, { renderLearningSetBlock }] = await Promise.all([
    vi.importActual<typeof import('@aflow/cybernetic-runtime/scheduling/output-path')>(
      '@aflow/cybernetic-runtime/scheduling/output-path',
    ),
    vi.importActual<typeof import('@aflow/cybernetic-runtime/learning/render')>(
      '@aflow/cybernetic-runtime/learning/render',
    ),
  ]);
  return {
    readOutputPath,
    parseOutputPath,
    renderLearningSetBlock,
    selectActiveLearningSetForRun: (...args: unknown[]) =>
      mockSelectActiveLearningSetForRun(...args),
    getRunCampaignId: (...args: unknown[]) => mockGetRunCampaignId(...args),
    getCampaignById: (...args: unknown[]) => mockGetCampaignById(...args),
    buildRunnerDelegationContext: vi.fn(),
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
    resolveRunnerModelHot: vi.fn(),
    resolveRunnerReasoningHot: vi.fn().mockResolvedValue(undefined),
    deriveEffectiveOutputSchema: vi.fn(),
    DeriveSchemaError: class extends Error {},
  };
});

vi.mock('@aflow/platform-artifacts', () => ({
  getPlatformWorkflow: vi.fn(),
}));

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN = 'run-1';

describe('resolveOperationTaskInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges task.inputs with task_output bindings and unwraps childOutput', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      tasks: [
        {
          taskId: 'analyze-intent',
          status: 'succeeded',
          // Agent task — runner output wrapped in delegation envelope.
          outputRef: inlineRef({
            childSessionId: 's',
            status: 'SUCCEEDED',
            childOutput: { intent: 'X', iterationModel: 'process' },
          }),
        },
      ],
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'prepare-design-surface',
        type: 'operation',
        operation: 'skill.compose.prepare_surface',
        inputs: { extra: 1 },
        inputBindings: {
          intent: { kind: 'task_output', taskId: 'analyze-intent' },
        },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['extra']).toBe(1);
    expect(result['intent']).toEqual({ intent: 'X', iterationModel: 'process' });
  });

  it('honors a path on task_output binding', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      tasks: [
        {
          taskId: 'upstream',
          status: 'succeeded',
          outputRef: inlineRef({ childOutput: { nested: { value: 42 } } }),
        },
      ],
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'op',
        type: 'operation',
        operation: 'whatever.do.it',
        inputBindings: {
          v: { kind: 'task_output', taskId: 'upstream', path: 'nested.value' },
        },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['v']).toBe(42);
  });

  it('throws when the upstream task is missing', async () => {
    mockLoadRunById.mockResolvedValueOnce({ runId: RUN, tasks: [] });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    await expect(
      resolveOperationTaskInputs(
        {
          taskId: 'op',
          type: 'operation',
          operation: 'whatever.do.it',
          inputBindings: { v: { kind: 'task_output', taskId: 'missing' } },
        } as never,
        TENANT,
        SPACE,
        RUN,
      ),
    ).rejects.toThrow(/does not exist in run/);
  });

  it('throws when the upstream task has no usable output', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      tasks: [{ taskId: 'upstream', status: 'failed', outputRef: null }],
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    await expect(
      resolveOperationTaskInputs(
        {
          taskId: 'op',
          type: 'operation',
          operation: 'whatever.do.it',
          inputBindings: { v: { kind: 'task_output', taskId: 'upstream' } },
        } as never,
        TENANT,
        SPACE,
        RUN,
      ),
    ).rejects.toThrow(/output is unavailable/);
  });

  it('resolves run_input bindings from the run-level pool on a non-first task', async () => {
    // Run inputs are stored under parentTaskInputs (validated against the FIRST
    // task at start), but every task's run_input bindings must resolve against
    // them — a later operation task (push/open-pr) binds run inputs too. Without
    // the run-level pool, this throws "no run_input is available".
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      tasks: [],
      metadata: {
        parentTaskInputs: {
          taskId: 'discover',
          inputs: { repo: 'munchist/duality', branch: 'agent/x' },
        },
      },
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'push',
        type: 'operation',
        operation: 'code.repo.push',
        inputBindings: {
          repo: { kind: 'run_input', path: 'repo' },
          branch: { kind: 'run_input', path: 'branch' },
        },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['repo']).toBe('munchist/duality');
    expect(result['branch']).toBe('agent/x');
  });

  it('threads run.metadata.connectionBindingId into a connection_binding template (Plan 222 P3)', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      tasks: [],
      metadata: { connectionBindingId: 'gh-conn-7' },
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'list-repos',
        type: 'operation',
        operation: 'api.http.call',
        inputBindings: { githubConnection: { kind: 'connection_binding' } },
        inputTemplate: {
          apiId: 'github',
          endpointId: 'list_repos',
          bindingId: { $bind: 'githubConnection' },
        },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['bindingId']).toBe('gh-conn-7');
  });

  it('fails closed when the run has no pinned connection for a connection_binding', async () => {
    mockLoadRunById.mockResolvedValueOnce({ runId: RUN, tasks: [], metadata: {} });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    await expect(
      resolveOperationTaskInputs(
        {
          taskId: 'list-repos',
          type: 'operation',
          operation: 'api.http.call',
          inputBindings: { githubConnection: { kind: 'connection_binding' } },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'list_repos',
            bindingId: { $bind: 'githubConnection' },
          },
        } as never,
        TENANT,
        SPACE,
        RUN,
      ),
    ).rejects.toThrow(/no connection is pinned/);
  });

  it('threads the run identity and the consuming task id into the learning_set selector, rendering with the shared formatter', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      spaceId: SPACE,
      workflowSlug: 'open-pr-from-request',
      tasks: [],
      metadata: {},
    });
    mockSelectActiveLearningSetForRun.mockResolvedValueOnce({
      selected: [
        {
          kind: 'candidate',
          runId: 'run-0',
          learningId: 'l-1',
          category: 'worked',
          observation: 'build @aflow/schemas before typecheck',
          recommendation: 'run the package build first',
          confidence: 'medium',
        },
      ],
      omittedDueToBudget: 0,
      consolidationDue: false,
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'implement',
        type: 'operation',
        operation: 'code.agent.run',
        inputBindings: { learnings: { kind: 'learning_set' } },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(mockSelectActiveLearningSetForRun).toHaveBeenCalledWith({
      db: {},
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: 'open-pr-from-request',
      runId: RUN,
      taskId: 'implement',
    });
    expect(result['learnings']).toBe(
      '- [worked] build @aflow/schemas before typecheck → run the package build first',
    );
  });

  it('a frozen trial resolves campaign_input from the case-pinned config, never the live campaign row', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      evalBatchId: 'batch-1',
      tasks: [],
      metadata: { evalCampaignConfig: { threshold: 0.9 } },
    });
    // A drifted live row that must NOT be consulted.
    mockGetCampaignById.mockResolvedValue({ config: { threshold: 0.1 } });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'op',
        type: 'operation',
        operation: 'whatever.do.it',
        inputBindings: { threshold: { kind: 'campaign_input', path: 'threshold' } },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['threshold']).toBe(0.9);
    expect(mockGetRunCampaignId).not.toHaveBeenCalled();
    expect(mockGetCampaignById).not.toHaveBeenCalled();
  });

  it('a frozen trial with no pinned config fails the binding deterministically instead of reading live state', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      evalBatchId: 'batch-1',
      tasks: [],
      metadata: {},
    });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    await expect(
      resolveOperationTaskInputs(
        {
          taskId: 'op',
          type: 'operation',
          operation: 'whatever.do.it',
          inputBindings: { threshold: { kind: 'campaign_input', path: 'threshold' } },
        } as never,
        TENANT,
        SPACE,
        RUN,
      ),
    ).rejects.toThrow(/campaign config has no value/);
    expect(mockGetCampaignById).not.toHaveBeenCalled();
  });

  it('a production run still resolves campaign_input from its campaign row', async () => {
    mockLoadRunById.mockResolvedValueOnce({
      runId: RUN,
      evalBatchId: null,
      tasks: [],
      metadata: {},
    });
    mockGetRunCampaignId.mockResolvedValueOnce('camp-1');
    mockGetCampaignById.mockResolvedValueOnce({ config: { threshold: 0.7 } });
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'op',
        type: 'operation',
        operation: 'whatever.do.it',
        inputBindings: { threshold: { kind: 'campaign_input', path: 'threshold' } },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result['threshold']).toBe(0.7);
    expect(mockGetCampaignById).toHaveBeenCalledWith({}, TENANT, 'camp-1');
  });

  it('returns task.inputs untouched when no bindings are declared', async () => {
    const { resolveOperationTaskInputs } = await import('../taskHelpers.js');
    const result = await resolveOperationTaskInputs(
      {
        taskId: 'op',
        type: 'operation',
        operation: 'whatever.do.it',
        inputs: { foo: 'bar' },
      } as never,
      TENANT,
      SPACE,
      RUN,
    );
    expect(result).toEqual({ foo: 'bar' });
    expect(mockLoadRunById).not.toHaveBeenCalled();
  });
});
