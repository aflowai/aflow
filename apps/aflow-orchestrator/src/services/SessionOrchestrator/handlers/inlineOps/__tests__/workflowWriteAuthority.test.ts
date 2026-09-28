import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockResolveCampaignManifestParams = vi.fn();
const mockListActiveRuns = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    // DB-touching reads are mocked; materializeAndValidateSkillConfig and
    // renderSkillDiagnostics stay REAL so the rules genuinely fire.
    resolveCampaignManifestParams: (...args: unknown[]) =>
      mockResolveCampaignManifestParams(...args),
    listActiveRuns: (...args: unknown[]) => mockListActiveRuns(...args),
  };
});

const mockGetByPath = vi.fn();
const mockDocPut = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: (...args: unknown[]) => mockGetByPath(...args),
      put: (...args: unknown[]) => mockDocPut(...args),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      ensureParentDirs: vi.fn().mockResolvedValue(undefined),
    })),
    ensureWorkflowRevisionSnapshot: vi.fn(),
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
  addControlMessage: vi.fn(),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
}));

vi.mock('../../../../StepService/StepService.js', () => ({
  waitForInput: vi.fn().mockResolvedValue(undefined),
}));

import type { Workflow, WorkflowPatchInput, WorkflowPutInput } from '@aflow/schemas';
import { handleWorkflowPut } from '../workflowCrud/create.js';
import { handleWorkflowPatch } from '../workflowCrud/update.js';
import { resolveTaskIdPaths } from '../workflowCrud/validators.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const SLUG = 'lead-scoring';

const TASKS: Workflow['tasks'] = [
  { taskId: 'prepare-data', name: 'Prepare', goal: 'Prepare the data.', type: 'agent' },
  {
    taskId: 'train-model',
    name: 'Train',
    goal: 'Train the model.',
    type: 'agent',
    dependsOn: ['prepare-data'],
  },
];

function existingWorkflow(status: Workflow['status']): Workflow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: SLUG,
    name: 'Lead scoring',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'Done.' } }],
    mode: 'process',
    tasks: TASKS,
    iteration: { auto: false, maxConsecutiveRuns: 5, stopOnOutcomesMet: true, cooldownMs: 0 },
    stateVariables: [],
    revision: 3,
    status,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function putInput(): WorkflowPutInput {
  return {
    slug: SLUG,
    name: 'Lead scoring',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'Done.' } }],
    mode: 'process',
    tasks: TASKS,
    stateVariables: [],
    runInputs: [],
  };
}

function makeArgs(operation: string): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(),
      store: vi.fn(),
      shouldStore: vi.fn().mockReturnValue(false),
    } as never,
    context: {
      tenantId: TENANT,
      runId: '99999999-2222-3333-4444-555555555555',
      traceId: 'trace-1',
      spaceId: SPACE,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: { stepId: 'wf_op', stepType: 'workflow', operation, tags: [] } as never,
    stepExecutionId: 'step-exec-1' as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: 'inline:e30=',
    scheduledAtMs: Date.now(),
  };
}

function lastStepResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function errorCode(result: Record<string, unknown>): unknown {
  return (result['error'] as Record<string, unknown>)['code'];
}

function stored(workflow: Workflow) {
  return { inlineContent: JSON.stringify(workflow) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByPath.mockResolvedValue(null);
  mockDocPut.mockResolvedValue({ id: 'doc-1', path: 'p', currentVersion: 1 });
  mockListActiveRuns.mockResolvedValue([]);
  mockResolveCampaignManifestParams.mockResolvedValue(undefined);
});

describe('an agent creates a workflow; it does not replace or approve one', () => {
  it('creates a new workflow as a draft', async () => {
    await handleWorkflowPut(makeArgs('workflow.manage.put'), putInput(), Date.now());

    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    const written = JSON.parse(
      (mockDocPut.mock.calls[0]![0] as { inlineContent: string }).inlineContent,
    ) as Workflow;
    expect(written.status).toBe('draft');
    expect(written.origin).toBeUndefined();
    expect(written.revision).toBe(1);
  });

  it('refuses to put over an existing workflow and writes nothing', async () => {
    mockGetByPath.mockResolvedValue(stored(existingWorkflow('approved')));

    await handleWorkflowPut(makeArgs('workflow.manage.put'), putInput(), Date.now());

    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect(errorCode(result)).toBe('WORKFLOW_ALREADY_EXISTS');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('refuses a patch that approves a workflow, and writes nothing', async () => {
    mockGetByPath.mockResolvedValue(stored(existingWorkflow('draft')));
    const input: WorkflowPatchInput = {
      slug: SLUG,
      operations: [{ op: 'replace', path: '/status', value: 'approved' }],
    };

    await handleWorkflowPatch(makeArgs('workflow.manage.patch'), input, Date.now());

    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect(errorCode(result)).toBe('WORKFLOW_APPROVAL_IS_OPERATOR');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('applies a patch that moves a workflow out of approved', async () => {
    mockGetByPath.mockResolvedValue(stored(existingWorkflow('approved')));
    const input: WorkflowPatchInput = {
      slug: SLUG,
      operations: [{ op: 'replace', path: '/status', value: 'completed' }],
    };

    await handleWorkflowPatch(makeArgs('workflow.manage.patch'), input, Date.now());

    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    const written = JSON.parse(
      (mockDocPut.mock.calls[0]![0] as { inlineContent: string }).inlineContent,
    ) as Workflow;
    expect(written.status).toBe('completed');
  });
});

describe('resolveTaskIdPaths', () => {
  it('rewrites a task id to its index, and leaves indices, "-" and unknown ids alone', () => {
    const ops = resolveTaskIdPaths(
      [
        { op: 'replace', path: '/tasks/train-model/goal', value: 'x' },
        { op: 'remove', path: '/tasks/prepare-data' },
        { op: 'replace', path: '/tasks/0/goal', value: 'y' },
        { op: 'add', path: '/tasks/-', value: {} },
        { op: 'remove', path: '/tasks/no-such-task' },
        { op: 'replace', path: '/budget/maxRuns', value: 3 },
      ],
      TASKS,
    );
    expect(ops.map((o) => o.path)).toEqual([
      '/tasks/1/goal',
      '/tasks/0',
      '/tasks/0/goal',
      '/tasks/-',
      '/tasks/no-such-task',
      '/budget/maxRuns',
    ]);
  });
});
