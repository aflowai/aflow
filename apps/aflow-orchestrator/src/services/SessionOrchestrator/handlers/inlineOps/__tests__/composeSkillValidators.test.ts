import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { ContractErrorSchema } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type {
  StepDefinition,
  StepExecutionId,
  IdempotencyKey,
  Workflow,
  WorkflowTask,
} from '@aflow/schemas';

// ============================================================================
// Mocks
// ============================================================================

const mockAddStepResult = vi.fn();
const mockGetSessionState = vi.fn();
const mockLoadRunById = vi.fn();
const mockResolveWorkflowForRunRevision = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    resolveWorkflowForRunRevision: (...args: unknown[]) =>
      mockResolveWorkflowForRunRevision(...args),
  };
});

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  };
});

// ============================================================================
// Test fixtures
// ============================================================================

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '11111111-1111-4111-8111-111111111111';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

interface MakeArgsOpts {
  consumerTaskId: string;
  operation: string;
  inputBindings: Record<string, unknown>;
  resolvedInput: unknown;
  /**
   * Workflow run id stored in `SessionHotState.workflowExecution.runId`.
   * Defaults to a value DIFFERENT from `SESSION` so tests can verify the
   * handler reads the typed correlation, not `context.runId`.
   */
  workflowRunId?: string;
}

const DEFAULT_WORKFLOW_RUN_ID = '99999999-9999-4999-8999-999999999999';

function makeArgs(opts: MakeArgsOpts): {
  redis: never;
  payloadStore: never;
  context: {
    tenantId: string;
    runId: string;
    spaceId: string;
    traceId: string;
    agentDefinition: { steps: StepDefinition[] };
  };
  stepDef: StepDefinition;
  stepExecutionId: StepExecutionId;
  idempotencyKey: IdempotencyKey;
  resolvedInputRef: string;
  attempt: number;
  scheduledAtMs: number;
} {
  const stepDef = {
    stepId: `wf_task__${opts.consumerTaskId}__execute__a1`,
    stepType: 'skill',
    operation: opts.operation,
    config: {},
    tags: ['dynamic', `_taskId:${opts.consumerTaskId}`],
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;

  const workflowRunId = opts.workflowRunId ?? DEFAULT_WORKFLOW_RUN_ID;
  mockGetSessionState.mockResolvedValue({
    workflowExecution: {
      runId: workflowRunId,
      taskId: opts.consumerTaskId,
      attempt: 1,
    },
    runtimeState: {
      version: 1,
      updatedAtMs: Date.now(),
      variables: {},
    },
  });
  mockLoadRunById.mockImplementation(async (_db: unknown, _t: string, _s: string, runId: string) =>
    runId === workflowRunId
      ? { runId: workflowRunId, workflowSlug: 'compose-skill', workflowRevision: 1, tasks: [] }
      : null,
  );
  const consumerTask = {
    taskId: opts.consumerTaskId,
    name: opts.consumerTaskId,
    goal: 'g',
    type: 'operation',
    operation: opts.operation,
    inputBindings: opts.inputBindings,
  } as unknown as WorkflowTask;
  const workflow = {
    id: '00000000-0000-0000-0000-000000000aaa',
    slug: 'compose-skill',
    name: 'compose-skill',
    description: '',
    outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
    mode: 'process' as const,
    tasks: [
      consumerTask,
      // Producer stubs the validators reference via inputBindings.
      {
        taskId: 'draft-task-graph',
        name: 'd',
        goal: 'g',
        type: 'agent',
      } as unknown as WorkflowTask,
      { taskId: 'analyze-intent', name: 'i', goal: 'g', type: 'agent' } as unknown as WorkflowTask,
      {
        taskId: 'prepare-design-surface',
        name: 's',
        goal: 'g',
        type: 'operation',
      } as unknown as WorkflowTask,
      {
        taskId: 'draft-evals',
        name: 'e',
        goal: 'g',
        type: 'agent',
      } as unknown as WorkflowTask,
      {
        taskId: 'assemble-workflow',
        name: 'a',
        goal: 'g',
        type: 'operation',
      } as unknown as WorkflowTask,
    ],
    stateVariables: [],
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    revision: 1,
    status: 'approved' as const,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  } as unknown as Workflow;
  mockResolveWorkflowForRunRevision.mockResolvedValue({ workflow, source: 'revision' as const });

  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION,
      spaceId: SPACE,
      traceId: 'trace-1',
      agentDefinition: { steps: [stepDef] },
    },
    stepDef,
    stepExecutionId: 'step-exec-1' as StepExecutionId,
    idempotencyKey: 'idemp-1' as IdempotencyKey,
    resolvedInputRef: inlineRef(opts.resolvedInput),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function getEmittedCall(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

// ============================================================================
// Engine-meta runId lookup
// ============================================================================
//
// Pins the P1 fix: handlers must use `SessionHotState.workflowExecution.runId`
// for the DB lookup, NOT `context.runId` (the platform SessionId). For
// delegated worker sessions (the common case for compose-skill) the two are
// different — using context.runId yields `COMPOSE_VALIDATOR_RUN_NOT_FOUND`
// before any ContractError can be constructed.

describe('workflowExecution runId lookup', () => {
  function validDraft(): unknown {
    return {
      slug: 'echo',
      name: 'Echo',
      description: '',
      goal: 'g',
      outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
      tasks: [{ type: 'agent', kind: 'transformer', taskId: 'echo', goal: 'g' }],
    };
  }

  it('uses workflowExecution.runId (NOT context.runId) when looking up the workflow run', async () => {
    vi.clearAllMocks();
    const distinctWorkflowRunId = '88888888-8888-4888-8888-888888888888';
    const args = makeArgs({
      consumerTaskId: 'validate-task-graph',
      operation: 'skill.compose.validate_task_graph',
      inputBindings: { draft: { kind: 'task_output', taskId: 'draft-task-graph' } },
      resolvedInput: { draft: validDraft() },
      workflowRunId: distinctWorkflowRunId,
    });
    expect(args.context.runId).not.toBe(distinctWorkflowRunId); // sanity: ids differ.

    const { handleValidateTaskGraphInline } = await import('../composeSkillValidators.js');
    await handleValidateTaskGraphInline(args as never);

    // loadRunById was called with workflowExecution.runId, NOT context.runId.
    expect(mockLoadRunById).toHaveBeenCalled();
    const lookupRunId = mockLoadRunById.mock.calls[0]![3] as string;
    expect(lookupRunId).toBe(distinctWorkflowRunId);
    expect(lookupRunId).not.toBe(args.context.runId);
    // And the validator still emits success (the lookup resolved the run).
    const call = getEmittedCall();
    expect(call['status']).toBe('SUCCEEDED');
  });

  it('emits a configuration error when workflowExecution is missing from session hot state', async () => {
    vi.clearAllMocks();
    // Session state present but workflowExecution absent — handler should
    // fail loud rather than fall back to context.runId.
    mockGetSessionState.mockResolvedValue({
      runtimeState: { version: 1, updatedAtMs: Date.now(), variables: {} },
    });
    const stepDef = {
      stepId: `wf_task__validate-task-graph__execute__a1`,
      stepType: 'skill',
      operation: 'skill.compose.validate_task_graph',
      config: {},
      tags: ['dynamic', `_taskId:validate-task-graph`],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition;
    const args = {
      redis: {} as never,
      payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
      context: {
        tenantId: TENANT,
        runId: SESSION,
        spaceId: SPACE,
        traceId: 'trace-1',
        agentDefinition: { steps: [stepDef] },
      },
      stepDef,
      stepExecutionId: 'step-exec-1' as StepExecutionId,
      idempotencyKey: 'idemp-1' as IdempotencyKey,
      resolvedInputRef: inlineRef({ draft: validDraft() }),
      attempt: 1,
      scheduledAtMs: Date.now(),
    };

    const { handleValidateTaskGraphInline } = await import('../composeSkillValidators.js');
    await handleValidateTaskGraphInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('FAILED');
    const errorPayload = decodeInline(call['errorRef'] as string);
    expect(errorPayload['code']).toBe('COMPOSE_VALIDATOR_NO_WORKFLOW_EXECUTION');
    // No DB lookup happened — handler short-circuited.
    expect(mockLoadRunById).not.toHaveBeenCalled();
  });
});

// ============================================================================
// validate_task_graph
// ============================================================================

describe('handleValidateTaskGraphInline', () => {
  function validDraft(): unknown {
    return {
      slug: 'echo',
      name: 'Echo',
      description: '',
      goal: 'g',
      outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
      tasks: [{ type: 'agent', kind: 'transformer', taskId: 'echo', goal: 'g' }],
    };
  }

  it('emits SUCCESS with { valid: true } on a self-consistent draft', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-task-graph',
      operation: 'skill.compose.validate_task_graph',
      inputBindings: { draft: { kind: 'task_output', taskId: 'draft-task-graph' } },
      resolvedInput: { draft: validDraft() },
    });
    const { handleValidateTaskGraphInline } = await import('../composeSkillValidators.js');
    await handleValidateTaskGraphInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('SUCCEEDED');
    expect(decodeInline(call['outputRef'] as string)).toEqual({ valid: true });
  });

  it('routes an input SCHEMA (Zod superRefine) failure to the producer for rerun (Plan 206 §2.2)', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-task-graph',
      operation: 'skill.compose.validate_task_graph',
      inputBindings: { draft: { kind: 'task_output', taskId: 'draft-task-graph' } },
      resolvedInput: {
        draft: {
          slug: 'broken',
          name: 'Broken',
          description: '',
          goal: 'g',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          // `produces[].shape` omitted on a port no operation consumes — a
          // TaskGraphDraftSchema superRefine the JSON submit_output surface
          // can't carry. Pre-206 this died as a terminal
          // COMPOSE_VALIDATOR_INPUT_INVALID; now it routes to the producer.
          tasks: [
            {
              type: 'agent',
              kind: 'transformer',
              taskId: 'a',
              goal: 'g',
              produces: [{ key: 'out' }],
            },
          ],
        },
      },
    });
    const { handleValidateTaskGraphInline } = await import('../composeSkillValidators.js');
    await handleValidateTaskGraphInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('FAILED');
    const errorPayload = decodeInline(call['errorRef'] as string);
    const contractErrors = errorPayload['contractErrors'] as unknown[];
    expect(contractErrors.length).toBeGreaterThan(0);
    for (const err of contractErrors) {
      const parsed = ContractErrorSchema.safeParse(err);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.blame).toBe('producer-contract');
      expect(parsed.data.contractName).toBe('compose-input-schema');
      if (parsed.data.source.kind === 'binding') {
        expect(parsed.data.source.bindAs).toBe('draft');
        expect(parsed.data.source.producerTaskId).toBe('draft-task-graph');
      }
    }
  });

  it('emits FAILED with contractErrors that round-trip through ContractErrorSchema on a dangling reference', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-task-graph',
      operation: 'skill.compose.validate_task_graph',
      inputBindings: { draft: { kind: 'task_output', taskId: 'draft-task-graph' } },
      resolvedInput: {
        draft: {
          slug: 'broken',
          name: 'Broken',
          description: '',
          goal: 'g',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          tasks: [
            { type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g', dependsOn: ['ghost'] },
          ],
        },
      },
    });
    const { handleValidateTaskGraphInline } = await import('../composeSkillValidators.js');
    await handleValidateTaskGraphInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('FAILED');
    const errorPayload = decodeInline(call['errorRef'] as string);
    const contractErrors = errorPayload['contractErrors'] as unknown[];
    expect(contractErrors.length).toBeGreaterThan(0);
    // Acceptance criterion: every entry parses through ContractErrorSchema.
    for (const err of contractErrors) {
      const parsed = ContractErrorSchema.safeParse(err);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.consumerTaskId).toBe('validate-task-graph');
      expect(parsed.data.blame).toBe('producer-contract');
      if (parsed.data.source.kind === 'binding') {
        expect(parsed.data.source.bindAs).toBe('draft');
        expect(parsed.data.source.producerTaskId).toBe('draft-task-graph');
      }
    }
  });
});

// ============================================================================
// validate_source_coverage
// ============================================================================

describe('handleValidateSourceCoverageInline', () => {
  it('emits SUCCESS when every requiredDataSource has a labelled producer with grant', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-source-coverage',
      operation: 'skill.compose.validate_source_coverage',
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
      resolvedInput: {
        intent: {
          intent: 'g',
          iterationModel: 'process',
          requiredCapabilities: [],
          requiredDataSources: [
            { purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' },
          ],
          taskShapeHints: [],
          pauseForUser: { needed: false },
        },
        draft: {
          slug: 'fetch',
          name: 'Fetch',
          description: '',
          goal: 'g',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          tasks: [
            {
              type: 'agent',
              kind: 'fetcher',
              taskId: 'fetch-kaggle',
              goal: 'g',
              produces: [
                {
                  key: 'data',
                  shape: { type: 'object' },
                  semantics: 'data',
                  providesPurposeId: 'kaggle-data',
                },
              ],
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api' as const,
                      integrationId: 'kaggle',
                      bindingId: 'b1',
                      toolNames: ['list'],
                    },
                  ],
                  operations: [],
                },
              },
            },
          ],
        },
      },
    });
    const { handleValidateSourceCoverageInline } = await import('../composeSkillValidators.js');
    await handleValidateSourceCoverageInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('SUCCEEDED');
  });

  it('emits FAILED with bindAs=draft, producerTaskId=draft-task-graph when producer is missing', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-source-coverage',
      operation: 'skill.compose.validate_source_coverage',
      inputBindings: {
        intent: { kind: 'task_output', taskId: 'analyze-intent' },
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
      },
      resolvedInput: {
        intent: {
          intent: 'g',
          iterationModel: 'process',
          requiredCapabilities: [],
          requiredDataSources: [
            { purposeId: 'kaggle-data', sourceKind: 'api', sourceId: 'kaggle' },
          ],
          taskShapeHints: [],
          pauseForUser: { needed: false },
        },
        draft: {
          slug: 'fetch',
          name: 'Fetch',
          description: '',
          goal: 'g',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          tasks: [{ type: 'agent', kind: 'transformer', taskId: 'a', goal: 'g' }],
        },
      },
    });
    const { handleValidateSourceCoverageInline } = await import('../composeSkillValidators.js');
    await handleValidateSourceCoverageInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('FAILED');
    const errorPayload = decodeInline(call['errorRef'] as string);
    const contractErrors = errorPayload['contractErrors'] as unknown[];
    expect(contractErrors).toHaveLength(1);
    const parsed = ContractErrorSchema.safeParse(contractErrors[0]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.source.kind === 'binding') {
      // Even though the violation references intent.requiredDataSources, the
      // blame routes to the DRAFT (which is the producer that needs to add a
      // labelled task). This is the path-correctness invariant the helper
      // tests pinned.
      expect(parsed.data.source.bindAs).toBe('draft');
      expect(parsed.data.source.producerTaskId).toBe('draft-task-graph');
    }
  });
});

// ============================================================================
// capability.validate_grants
// ============================================================================

describe('handleCapabilityValidateGrantsInline', () => {
  it('emits FAILED with bindAs=draft when a grant references an unbound apiId', async () => {
    vi.clearAllMocks();
    const args = makeArgs({
      consumerTaskId: 'validate-capability-grants',
      operation: 'capability.validate.grants',
      inputBindings: {
        draft: { kind: 'task_output', taskId: 'draft-task-graph' },
        surface: {
          kind: 'task_output',
          taskId: 'prepare-design-surface',
          path: 'designSurface',
        },
      },
      resolvedInput: {
        draft: {
          slug: 'fetch',
          name: 'Fetch',
          description: '',
          goal: 'g',
          outcomes: [{ id: 'o1', name: 'o1', evaluator: { type: 'manual', instruction: 'm' } }],
          tasks: [
            {
              type: 'agent',
              kind: 'fetcher',
              taskId: 'a',
              goal: 'g',
              context: {
                capabilities: {
                  integrations: [
                    {
                      sourceKind: 'api' as const,
                      integrationId: 'unbound',
                      bindingId: 'b1',
                      toolNames: ['list'],
                    },
                  ],
                  operations: [],
                },
              },
            },
          ],
        },
        surface: {
          integrations: [],
          operations: [],
          policies: { compute: false },
          bindableButUnbound: [],
        },
      },
    });
    const { handleCapabilityValidateGrantsInline } = await import('../composeSkillValidators.js');
    await handleCapabilityValidateGrantsInline(args as never);

    const call = getEmittedCall();
    expect(call['status']).toBe('FAILED');
    const errorPayload = decodeInline(call['errorRef'] as string);
    const contractErrors = errorPayload['contractErrors'] as unknown[];
    expect(contractErrors.length).toBeGreaterThan(0);
    for (const err of contractErrors) {
      const parsed = ContractErrorSchema.safeParse(err);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      if (parsed.data.source.kind === 'binding') {
        expect(parsed.data.source.bindAs).toBe('draft');
        expect(parsed.data.source.producerTaskId).toBe('draft-task-graph');
      }
    }
  });
});
