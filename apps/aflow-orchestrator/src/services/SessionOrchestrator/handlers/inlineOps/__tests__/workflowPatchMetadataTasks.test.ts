import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

// Sentinel re-materialized tasks — distinct from the authored `tasks` on the
// stored workflow. A metadata-only patch must NOT persist this form; a
// definition patch runs through the proposal pipeline and never writes it to
// the workflow doc either. If either path wrote the sentinel into the doc, the
// assertions below fail.
const MATERIALIZED_SENTINEL = [{ taskId: 'task-a', name: 'A', goal: 'g', __materialized: true }];

const mockMaterialize = vi.fn(() => ({
  materializedTasks: MATERIALIZED_SENTINEL,
  validity: {
    status: 'valid',
    diagnostics: [],
    advisories: [],
    validatedAt: '2026-01-01T00:00:00.000Z',
  },
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  materializeAndValidateSkillConfig: (...args: unknown[]) => mockMaterialize(...args),
  renderSkillDiagnostics: () => '',
  runWorkflowProposalValidations: vi.fn().mockReturnValue({
    contract: { status: 'valid' },
  }),
  isProposalReadinessSafe: vi.fn().mockReturnValue(true),
  proposalReadinessWarningCount: vi.fn().mockReturnValue(0),
  proposalReadinessBlockerCount: vi.fn().mockReturnValue(0),
  loadProposalValidationSnapshot: vi.fn().mockResolvedValue({}),
  computeProposalPreconditions: vi.fn().mockReturnValue({}),
  resolveProposalRoute: vi.fn().mockReturnValue('space_local'),
  listActiveRuns: vi.fn().mockResolvedValue([]),
  resolveCampaignManifestParams: vi.fn().mockResolvedValue(undefined),
  resolveSkillForWorkflow: vi.fn().mockResolvedValue(null),
  WorkflowArchivedError: class extends Error {},
}));

const putMock = vi.fn();
const getByPathMock = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: (...args: unknown[]) => getByPathMock(...args),
      put: (...args: unknown[]) => putMock(...args),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      ensureParentDirs: vi.fn(),
      mkdir: vi.fn(),
    })),
    workflowDirPath: (slug: string) => `/workflows/${slug}`,
    workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addControlMessage: vi.fn(),
  getSessionState: vi.fn().mockResolvedValue(null),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  appendEntityEvent: vi.fn(),
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

const AUTHORED_TASKS = [
  { taskId: 'task-a', name: 'A', goal: 'do the thing', type: 'agent', agent: 'runner' },
];

function makeExistingWorkflow(): Workflow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    slug: 'kaggle-optimizer',
    name: 'Kaggle Optimizer',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'ship it' } }],
    mode: 'optimization',
    tasks: JSON.parse(JSON.stringify(AUTHORED_TASKS)),
    stateVariables: [],
    runInputs: [],
    iteration: { auto: false, maxConsecutiveRuns: 5, stopOnOutcomesMet: true, cooldownMs: 0 },
    budget: { maxRuns: 10 },
    revision: 4,
    status: 'approved',
    origin: 'cloned',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Workflow;
}

function makePatchArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockImplementation((ref: string) => {
        if (ref === inputRef) return Promise.resolve(input);
        return Promise.resolve(null);
      }),
      shouldStore: vi.fn().mockReturnValue(false),
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
      operation: 'workflow.manage.patch',
      tags: [],
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function lastWrittenWorkflowDoc(): Workflow | undefined {
  const call = putMock.mock.calls.find(
    (c) => (c[0] as { path?: string }).path === '/workflows/kaggle-optimizer/workflow.json',
  );
  if (!call) return undefined;
  const content = (call[0] as { inlineContent: string }).inlineContent;
  return JSON.parse(content) as Workflow;
}

beforeEach(() => {
  vi.clearAllMocks();
  putMock.mockResolvedValue({
    id: 'doc-1',
    path: '/workflows/kaggle-optimizer/workflow.json',
    currentVersion: 2,
  });
  getByPathMock.mockImplementation((path: string) => {
    if (path === '/workflows/kaggle-optimizer/workflow.json') {
      const wf = makeExistingWorkflow();
      return Promise.resolve({ inlineContent: JSON.stringify(wf) });
    }
    return Promise.resolve(null);
  });
});

describe('workflow.manage.patch — metadata-only patch preserves authored tasks', () => {
  it('does NOT rewrite tasks to the re-materialized form when only budget changes', async () => {
    await handleWorkflowCrudInline(
      makePatchArgs({
        slug: 'kaggle-optimizer',
        operations: [{ op: 'replace', path: '/budget/maxRuns', value: 25 }],
      }),
    );

    // A metadata-only patch persists directly at the same revision.
    const written = lastWrittenWorkflowDoc();
    expect(written).toBeDefined();
    expect(written!.revision).toBe(4);
    expect(written!.budget?.maxRuns).toBe(25);

    // The stored tasks must equal the authored form — NOT the re-materialized
    // sentinel. Persisting re-materialized tasks at the same revision is the
    // exact drift that hard-fails the next workflow.run.start.
    expect(written!.tasks).toEqual(AUTHORED_TASKS);
    expect(written!.tasks).not.toContainEqual(expect.objectContaining({ __materialized: true }));
  });

  it('does NOT rewrite tasks when adding a new /budget object', async () => {
    await handleWorkflowCrudInline(
      makePatchArgs({
        slug: 'kaggle-optimizer',
        operations: [{ op: 'add', path: '/budget', value: { maxRuns: 25 } }],
      }),
    );

    const written = lastWrittenWorkflowDoc();
    expect(written).toBeDefined();
    expect(written!.tasks).toEqual(AUTHORED_TASKS);
    expect(written!.tasks).not.toContainEqual(expect.objectContaining({ __materialized: true }));
  });

  it('routes a definition patch (tasks) through the proposal pipeline using the materialized form, never overwriting the workflow doc', async () => {
    await handleWorkflowCrudInline(
      makePatchArgs({
        slug: 'kaggle-optimizer',
        operations: [{ op: 'replace', path: '/tasks/0/goal', value: 'a different goal' }],
      }),
    );

    // Definition patches never mutate the workflow doc directly — they persist a
    // staged proposal. So the workflow.json doc is not overwritten here.
    expect(lastWrittenWorkflowDoc()).toBeUndefined();

    // A proposal doc IS written (under /coach/...), proving the definition path
    // still ran (and the materialized tasks feed validation there, as before).
    const proposalWrite = putMock.mock.calls.find((c) =>
      String((c[0] as { path?: string }).path ?? '').startsWith('/coach/'),
    );
    expect(proposalWrite).toBeDefined();

    const result = mockAddStepResult.mock.calls[0]![1] as { status: string };
    expect(result.status).toBe('SUCCEEDED');
  });
});
