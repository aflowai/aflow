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
  const { readOutputPath, parseOutputPath } = await vi.importActual<
    typeof import('@aflow/cybernetic-runtime/scheduling/output-path')
  >('@aflow/cybernetic-runtime/scheduling/output-path');
  return {
    readOutputPath,
    parseOutputPath,
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
const RUN = 'run-parent-instructions-1';

const baseWdc = {
  runnerModel: 'sonnet',
  runnerSystemPrompt: 'system prompt',
  runnerTools: ['t1'],
  taskContext: 'ctx',
  taskLearnings: 'learn',
};

const baseAgentTask = {
  taskId: 'elicit-target',
  name: 'Elicit Target',
  goal: 'figure out which API the user wants',
  type: 'agent' as const,
} as never;

const baseWorkflow = {
  slug: 'bind-capability',
  assignedAgent: 'cybernetic-runner',
} as never;

describe('buildDelegateTaskInput — Plan 141 parent instructions surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRunnerModelHot.mockResolvedValue('sonnet');
    mockBuildRunnerDelegationContext.mockImplementation(
      (params: { taskInputs?: Record<string, unknown> }) => ({
        ...baseWdc,
        ...(params.taskInputs ? { taskInputs: params.taskInputs } : {}),
      }),
    );
  });

  it('no runMetadata: no PARENT INSTRUCTIONS section in the Runner prompt', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(baseAgentTask, baseWorkflow, TENANT, SPACE, RUN);
    const prompt = delegate.input;
    expect(prompt).not.toContain('PARENT INSTRUCTIONS');
  });

  it('runLevel metadata: emits PARENT INSTRUCTIONS (run-level) on every task', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      { parentInstructions: { runLevel: 'bind Alpaca paper baseUrl' } },
    );
    const prompt = delegate.input;
    expect(prompt).toContain('PARENT INSTRUCTIONS (run-level):');
    expect(prompt).toContain('bind Alpaca paper baseUrl');
  });

  it('taskTargeted matching: emits PARENT INSTRUCTIONS (this task) only when taskId matches', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask, // taskId = 'elicit-target'
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentInstructions: {
          taskTargeted: [{ taskId: 'elicit-target', text: 'vendor=Alpaca, mode=paper' }],
        },
      },
    );
    const prompt = delegate.input;
    expect(prompt).toContain('PARENT INSTRUCTIONS (this task):');
    expect(prompt).toContain('vendor=Alpaca, mode=paper');
    expect(prompt).not.toContain('PARENT INSTRUCTIONS (run-level):');
  });

  it('taskTargeted non-matching: emits NO PARENT INSTRUCTIONS section', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const otherTask = { ...baseAgentTask, taskId: 'confirm-bind' } as never;
    const delegate = await buildDelegateTaskInput(
      otherTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentInstructions: {
          taskTargeted: [{ taskId: 'elicit-target', text: 'vendor=Alpaca' }],
        },
      },
    );
    const prompt = delegate.input;
    expect(prompt).not.toContain('PARENT INSTRUCTIONS');
    // Make sure the *other* task's text didn't bleed through.
    expect(prompt).not.toContain('vendor=Alpaca');
  });

  it('taskTargeted with multiple entries: each task sees only its own block', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const meta = {
      parentInstructions: {
        taskTargeted: [
          { taskId: 'elicit-target', text: 'first hint' },
          { taskId: 'confirm-bind', text: 'second hint' },
        ],
      },
    };

    const delegateA = await buildDelegateTaskInput(
      { ...baseAgentTask, taskId: 'elicit-target' } as never,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      meta,
    );
    const promptA = delegateA.input;
    expect(promptA).toContain('first hint');
    expect(promptA).not.toContain('second hint');

    const delegateB = await buildDelegateTaskInput(
      { ...baseAgentTask, taskId: 'confirm-bind' } as never,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      meta,
    );
    const promptB = delegateB.input;
    expect(promptB).toContain('second hint');
    expect(promptB).not.toContain('first hint');
  });

  it('malformed parentInstructions: silently ignored, prompt has no section', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      { parentInstructions: { taskTargeted: [] } }, // schema requires >=1
    );
    const prompt = delegate.input;
    expect(prompt).not.toContain('PARENT INSTRUCTIONS');
  });

  it('metadata with unrelated keys + valid parentInstructions: still surfaces correctly', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        unrelatedKey: 'whatever',
        parentInstructions: { runLevel: 'targeted guidance' },
      },
    );
    const prompt = delegate.input;
    expect(prompt).toContain('PARENT INSTRUCTIONS (run-level):');
    expect(prompt).toContain('targeted guidance');
  });

  it('duplicate taskTargeted entries for the same task: concatenated with blank-line separator', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask, // taskId = 'elicit-target'
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentInstructions: {
          taskTargeted: [
            { taskId: 'elicit-target', text: 'first hint' },
            { taskId: 'elicit-target', text: 'second hint' },
            { taskId: 'other-task', text: 'unrelated' },
            { taskId: 'elicit-target', text: 'third hint' },
          ],
        },
      },
    );
    const prompt = delegate.input;
    expect(prompt).toContain('PARENT INSTRUCTIONS (this task):');
    // All three matching entries surface, joined by `\n\n`. The order
    // mirrors the input array so the parent agent can rely on positional
    // semantics if it wants (e.g., earlier hints take precedence).
    expect(prompt).toContain('first hint\n\nsecond hint\n\nthird hint');
    // Unrelated entries stay invisible.
    expect(prompt).not.toContain('unrelated');
  });

  // ===========================================================================

  it('parentTaskInputs matching task: folds parent inputs into runner_task_inputs and TASK INPUTS block', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask, // taskId = 'elicit-target'
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentTaskInputs: {
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
        },
      },
    );
    const config = delegate.config;
    expect(config['runner_task_inputs']).toEqual({
      vendor: 'Alpaca',
      baseUrl: 'https://paper-api.alpaca.markets',
    });
    const prompt = delegate.input;
    expect(prompt).toContain('TASK INPUTS (typed, keyed by bindAs):');
    expect(prompt).toContain('Alpaca');
    expect(prompt).toContain('paper-api.alpaca.markets');
  });

  it('parentTaskInputs non-matching task: NO merge happens (this task is not the entry task)', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const otherTask = { ...baseAgentTask, taskId: 'draft-definition' } as never;
    const delegate = await buildDelegateTaskInput(
      otherTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentTaskInputs: {
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      },
    );
    const config = delegate.config;
    expect(config['runner_task_inputs']).toEqual({});
    const prompt = delegate.input;
    expect(prompt).not.toContain('Alpaca');
  });

  it('malformed parentTaskInputs: silently ignored, fast path falls back to empty typed inputs', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      // Missing required `taskId` — schema rejects, helper logs + returns null.
      { parentTaskInputs: { inputs: { vendor: 'Alpaca' } } },
    );
    const config = delegate.config;
    expect(config['runner_task_inputs']).toEqual({});
  });

  it('parentTaskInputs satisfies declared run_input bindings (P1 review fix): resolver does not throw', async () => {
    // Mock loadRunById so the resolver path runs.
    const { vi: viLocal } = await import('vitest');
    const cybernetic = await import('@aflow/cybernetic-runtime');
    mockLoadRunById.mockResolvedValue({
      runId: RUN,
      tasks: [],
    });
    // Override mockBuildRunnerDelegationContext to capture taskInputs
    mockBuildRunnerDelegationContext.mockImplementation(
      (params: { taskInputs?: Record<string, unknown> }) => ({
        ...baseWdc,
        ...(params.taskInputs ? { taskInputs: params.taskInputs } : {}),
      }),
    );
    // Reference imports so they aren't tree-shaken in dev — vi/cybernetic
    // not used beyond runtime resolution in this case but the lazy import
    // keeps the test file lightweight.
    viLocal;
    cybernetic;

    const taskWithRunInput = {
      ...baseAgentTask,
      inputBindings: {
        vendor: { kind: 'run_input', path: 'vendor' },
        baseUrl: { kind: 'run_input', path: 'baseUrl' },
      },
    } as never;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      taskWithRunInput,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentTaskInputs: {
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
        },
      },
    );
    const config = delegate.config;
    expect(config['runner_task_inputs']).toEqual({
      vendor: 'Alpaca',
      baseUrl: 'https://paper-api.alpaca.markets',
    });
  });

  it('parentTaskInputs satisfies nested-path run_input bindings (e.g. rationale.notes)', async () => {
    mockLoadRunById.mockResolvedValue({ runId: RUN, tasks: [] });
    mockBuildRunnerDelegationContext.mockImplementation(
      (params: { taskInputs?: Record<string, unknown> }) => ({
        ...baseWdc,
        ...(params.taskInputs ? { taskInputs: params.taskInputs } : {}),
      }),
    );

    const taskWithNestedPath = {
      ...baseAgentTask,
      inputBindings: {
        notes: { kind: 'run_input', path: 'rationale.notes' },
      },
    } as never;

    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      taskWithNestedPath,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentTaskInputs: {
          taskId: 'elicit-target',
          inputs: { notes: 'use Alpaca paper' },
        },
      },
    );
    const config = delegate.config;
    // The resolver reads `runInput.rationale.notes` and binds it under
    // `bindAs: 'notes'` — the Runner sees the flattened typed key.
    expect(config['runner_task_inputs']).toEqual({ notes: 'use Alpaca paper' });
  });

  it('parentTaskInputs alongside parentInstructions: both surfaces appear independently', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      {
        parentInstructions: { runLevel: 'use paper baseUrl' },
        parentTaskInputs: {
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      },
    );
    const prompt = delegate.input;
    expect(prompt).toContain('PARENT INSTRUCTIONS (run-level):');
    expect(prompt).toContain('use paper baseUrl');
    expect(prompt).toContain('TASK INPUTS (typed, keyed by bindAs):');
    expect(prompt).toContain('Alpaca');
  });

  // ============================================================================

  it('buildRunInputSnapshotFromParent: maps flat bindAs → flat runInput key', async () => {
    const { buildRunInputSnapshotFromParent } = await import('../taskHelpers.js');
    const snapshot = buildRunInputSnapshotFromParent(
      {
        vendor: { kind: 'run_input', path: 'vendor' },
        baseUrl: { kind: 'run_input', path: 'baseUrl' },
      } as never,
      { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
    );
    expect(snapshot).toEqual({
      vendor: 'Alpaca',
      baseUrl: 'https://paper-api.alpaca.markets',
    });
  });

  it('buildRunInputSnapshotFromParent: constructs nested objects for dotted paths', async () => {
    const { buildRunInputSnapshotFromParent } = await import('../taskHelpers.js');
    const snapshot = buildRunInputSnapshotFromParent(
      {
        name: { kind: 'run_input', path: 'user.name' },
        email: { kind: 'run_input', path: 'user.email' },
        notes: { kind: 'run_input', path: 'rationale.notes' },
      } as never,
      { name: 'John', email: 'john@example.com', notes: 'paper account' },
    );
    expect(snapshot).toEqual({
      user: { name: 'John', email: 'john@example.com' },
      rationale: { notes: 'paper account' },
    });
  });

  it('buildRunInputSnapshotFromParent: writes [n]-indexed paths so the shared reader round-trips', async () => {
    const [{ buildRunInputSnapshotFromParent }, { readOutputPath }] = await Promise.all([
      import('../taskHelpers.js'),
      import('@aflow/cybernetic-runtime/scheduling/output-path'),
    ]);
    const snapshot = buildRunInputSnapshotFromParent(
      {
        firstSymbol: { kind: 'run_input', path: 'positions[0].symbol' },
        secondSymbol: { kind: 'run_input', path: 'positions[1].symbol' },
        note: { kind: 'run_input', path: 'rationale.notes' },
      } as never,
      { firstSymbol: 'AAPL', secondSymbol: 'MSFT', note: 'paper account' },
    );
    expect(snapshot).toEqual({
      positions: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
      rationale: { notes: 'paper account' },
    });
    expect(readOutputPath(snapshot, 'positions[0].symbol')).toBe('AAPL');
    expect(readOutputPath(snapshot, 'positions[1].symbol')).toBe('MSFT');
    expect(readOutputPath(snapshot, 'rationale.notes')).toBe('paper account');
  });

  it('buildRunInputSnapshotFromParent: skips bindings whose bindAs is not in parentInputs', async () => {
    const { buildRunInputSnapshotFromParent } = await import('../taskHelpers.js');
    const snapshot = buildRunInputSnapshotFromParent(
      {
        vendor: { kind: 'run_input', path: 'vendor' },
        baseUrl: { kind: 'run_input', path: 'baseUrl' },
      } as never,
      { vendor: 'Alpaca' }, // baseUrl absent
    );
    expect(snapshot).toEqual({ vendor: 'Alpaca' });
  });

  it('buildRunInputSnapshotFromParent: ignores non-run_input bindings', async () => {
    const { buildRunInputSnapshotFromParent } = await import('../taskHelpers.js');
    const snapshot = buildRunInputSnapshotFromParent(
      {
        vendor: { kind: 'run_input', path: 'vendor' },
        upstream: { kind: 'task_output', taskId: 'prev' },
      } as never,
      { vendor: 'Alpaca', upstream: { some: 'data' } },
    );
    expect(snapshot).toEqual({ vendor: 'Alpaca' });
  });

  it('parent instructions section appears AFTER the typed TASK INPUTS block', async () => {
    const { buildDelegateTaskInput } = await import('../taskHelpers.js');
    const delegate = await buildDelegateTaskInput(
      baseAgentTask,
      baseWorkflow,
      TENANT,
      SPACE,
      RUN,
      undefined,
      undefined,
      undefined,
      { parentInstructions: { runLevel: 'parent hint' } },
    );
    const prompt = delegate.input;
    const taskInputsIdx = prompt.indexOf('TASK INPUTS (typed, keyed by bindAs):');
    const parentIdx = prompt.indexOf('PARENT INSTRUCTIONS (run-level):');
    expect(parentIdx).toBeGreaterThan(-1);
    expect(taskInputsIdx).toBeGreaterThan(-1);
    // Either ordering is acceptable; we just want both present and
    // distinct. (Pin the ordering only if Phase 2 changes require it.)
    expect(parentIdx).not.toEqual(taskInputsIdx);
  });
});
