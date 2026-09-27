import { Buffer } from 'node:buffer';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

// ── mocks ────────────────────────────────────────────────────────────────
// @aflow/schemas stays REAL — the SUT parses errorRef payloads with
// ContractErrorSchema and reads typed route fields off WorkflowTask.

vi.mock('@aflow/cybernetic-runtime', () => ({
  buildResumeContract: vi.fn((input: { pauseCause: string }) => ({ pauseCause: input.pauseCause })),
  commitProducerRerun: vi.fn(),
  computeDescendants: vi.fn(() => new Set(['validate-task-graph', 'assemble-workflow'])),
  countProducerReruns: vi.fn(() => 0),
  storeWorkflowResumeContract: vi.fn(async () => 'inline:contract'),
  casCompleteTask: vi.fn(async () => true),
}));

vi.mock('../helpers.js', () => ({
  bumpSchedulerCursorVersion: vi.fn(async () => {}),
  emitTaskUpdate: vi.fn(async () => {}),
}));

vi.mock('../pauseResume.js', () => ({
  applyFailureMode: vi.fn(async () => {}),
  pauseRunForTask: vi.fn(async () => {}),
}));

vi.mock('../dispatchRetriedTask.js', () => ({
  dispatchRetriedTask: vi.fn(async () => {}),
}));

import { tryRouteContractFailure } from '../contractFailureRoute.js';
import {
  buildResumeContract,
  casCompleteTask,
  commitProducerRerun,
  countProducerReruns,
  storeWorkflowResumeContract,
} from '@aflow/cybernetic-runtime';
import { applyFailureMode, pauseRunForTask } from '../pauseResume.js';
import { dispatchRetriedTask } from '../dispatchRetriedTask.js';
import { emitTaskUpdate } from '../helpers.js';

const mockCommit = commitProducerRerun as ReturnType<typeof vi.fn>;
const mockCount = countProducerReruns as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchRetriedTask as ReturnType<typeof vi.fn>;
const mockPause = pauseRunForTask as ReturnType<typeof vi.fn>;
const mockBuildContract = buildResumeContract as ReturnType<typeof vi.fn>;
const mockStoreContract = storeWorkflowResumeContract as ReturnType<typeof vi.fn>;
const mockCasComplete = casCompleteTask as ReturnType<typeof vi.fn>;
const mockApplyFailureMode = applyFailureMode as ReturnType<typeof vi.fn>;
const mockEmitTaskUpdate = emitTaskUpdate as ReturnType<typeof vi.fn>;

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_ID = '99999999-2222-3333-4444-555555555555';

function inlineErrorRef(contractErrors: unknown[]): string {
  return (
    'inline:' +
    Buffer.from(
      JSON.stringify({
        code: 'CONTRACT_INPUT_INVALID',
        message: 'contract violation',
        classification: 'validation',
        retryable: false,
        contractErrors,
      }),
    ).toString('base64')
  );
}

function producerContractError(over: Record<string, unknown> = {}) {
  return {
    code: 'CONTRACT_INPUT_INVALID',
    consumerTaskId: 'validate-task-graph',
    contractName: 'draft',
    expectedSchema: {},
    zodIssues: [{ path: ['tasks', 0], message: 'dangling ref to unknown task' }],
    blame: 'producer-contract',
    source: { kind: 'binding', bindAs: 'draft', producerTaskId: 'draft-task-graph' },
    ...over,
  };
}

// Minimal workflow with a draft producer + validator consumers carrying routes.
function workflow(consumerOverrides: Record<string, unknown> = {}) {
  return {
    slug: 'compose-skill',
    revision: 1,
    tasks: [
      { taskId: 'draft-task-graph', name: 'Draft', goal: 'g', type: 'agent' },
      {
        taskId: 'validate-task-graph',
        name: 'Validate',
        goal: 'g',
        type: 'operation',
        operation: 'skill.compose.validate_task_graph',
        outputContract: {
          schema: { type: 'object', properties: { valid: { const: true } }, required: ['valid'] },
        },
        onContractFailure: { perBinding: { draft: { producer: 'rerun', maxProducerReruns: 2 } } },
        ...consumerOverrides,
      },
      { taskId: 'assemble-workflow', name: 'Assemble', goal: 'g', type: 'operation' },
    ],
  } as never;
}

function run(producerOver: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    spaceId: 'space-1',
    sessionId: SESSION_ID,
    workflowSlug: 'compose-skill',
    workflowRevision: 1,
    tasks: [
      {
        taskId: 'draft-task-graph',
        status: 'succeeded',
        attempt: 1,
        priorFailures: [],
        ...producerOver,
      },
      { taskId: 'validate-task-graph', status: 'running', attempt: 1, priorFailures: [] },
    ],
  } as never;
}

function consumerRow() {
  return {
    taskId: 'validate-task-graph',
    status: 'running',
    attempt: 1,
    workerSessionId: 'worker-1',
    operationId: 'skill.compose.validate_task_graph',
    startedAt: new Date(),
    priorFailures: [],
  } as never;
}

const deps = {
  db: {} as never,
  redis: {} as never,
  payloadStore: { retrieve: vi.fn() } as never,
};

function baseArgs(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant' as never,
    run: run(),
    workflow: workflow(),
    consumerTaskRow: consumerRow(),
    attempt: 1,
    outcome: { kind: 'failed' as const, errorRef: inlineErrorRef([producerContractError()]) },
    ...over,
  };
}

describe('tryRouteContractFailure — Plan 202 §3.1 decision table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockReturnValue(0);
    mockCommit.mockResolvedValue({ kind: 'committed', newAttempt: 2, clearedTaskIds: [] });
  });

  it("producer:'rerun' with budget remaining → re-dispatches the blamed producer with system_feedback", async () => {
    const result = await tryRouteContractFailure(deps, baseArgs());
    expect(result).toEqual({ kind: 'reran' });
    expect(mockCommit).toHaveBeenCalledTimes(1);
    const commitArgs = mockCommit.mock.calls[0]![2] as Record<string, unknown>;
    expect(commitArgs['producerTaskId']).toBe('draft-task-graph');
    expect(commitArgs['expectedProducerAttempt']).toBe(1);
    // descendants keyed from the producer (incl. the failed consumer + assemble).
    expect(commitArgs['descendantTaskIds']).toEqual(['validate-task-graph', 'assemble-workflow']);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockDispatch.mock.calls[0]![1] as Record<string, unknown>;
    expect(dispatchArgs['taskId']).toBe('draft-task-graph');
    expect(dispatchArgs['attempt']).toBe(2);
    expect(dispatchArgs['helmsmanSessionId']).toBe(SESSION_ID);
    const feedback = dispatchArgs['systemFeedback'] as Record<string, unknown>;
    expect(feedback['blame']).toBe('producer-contract');
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('committed rerun → emits a cleared WorkflowTaskUpdate for every deleted descendant row', async () => {
    // The deleted descendants include the producer's parallel-dispatched
    // sibling consumers — without a clear event, any that already emitted
    // `running` sits stuck "running" in live surfaces.
    mockCommit.mockResolvedValue({
      kind: 'committed',
      newAttempt: 2,
      clearedTaskIds: ['validate-task-graph', 'validate-source-coverage', 'assemble-workflow'],
    });
    const result = await tryRouteContractFailure(deps, baseArgs());
    expect(result).toEqual({ kind: 'reran' });

    const clearedCalls = mockEmitTaskUpdate.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .filter((a) => a['cleared'] === true);
    expect(clearedCalls.map((a) => a['taskId'])).toEqual([
      'validate-task-graph',
      'validate-source-coverage',
      'assemble-workflow',
    ]);
    for (const call of clearedCalls) {
      expect(call['status']).toBe('scheduled');
      expect(call['runId']).toBe(RUN_ID);
    }
    // Label resolves from the workflow definition when present, else the taskId.
    expect(clearedCalls.find((a) => a['taskId'] === 'validate-task-graph')!['label']).toBe(
      'Validate',
    );
    expect(clearedCalls.find((a) => a['taskId'] === 'validate-source-coverage')!['label']).toBe(
      'validate-source-coverage',
    );
  });

  it('aggregates multiple same-producer violations into one system_feedback envelope', async () => {
    const errorRef = inlineErrorRef([
      producerContractError({ contractName: 'graph' }),
      producerContractError({
        contractName: 'coverage',
        zodIssues: [{ path: [], message: 'missing labelled producer' }],
      }),
    ]);
    await tryRouteContractFailure(deps, baseArgs({ outcome: { kind: 'failed', errorRef } }));
    const dispatchArgs = mockDispatch.mock.calls[0]![1] as Record<string, unknown>;
    const feedback = dispatchArgs['systemFeedback'] as { zodIssues: Array<{ message: string }> };
    expect(feedback.zodIssues).toHaveLength(2);
    // each issue is prefixed with its contractName so context survives the merge.
    expect(feedback.zodIssues[0]!.message).toContain('[graph]');
    expect(feedback.zodIssues[1]!.message).toContain('[coverage]');
  });

  it("producer:'rerun' with budget exhausted → pauses retry_budget_exceeded (does not rerun)", async () => {
    mockCount.mockReturnValue(2); // == maxProducerReruns
    const result = await tryRouteContractFailure(deps, baseArgs());
    expect(result).toEqual({ kind: 'paused' });
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockBuildContract).toHaveBeenCalledTimes(1);
    expect((mockBuildContract.mock.calls[0]![0] as { pauseCause: string }).pauseCause).toBe(
      'retry_budget_exceeded',
    );
    expect(mockStoreContract).toHaveBeenCalledTimes(1);
    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockPause.mock.calls[0]![6]).toBe('retry_budget_exceeded');
  });

  it("producer:'signal_blocked' → pauses task_contract_violation (escalation), no rerun", async () => {
    const errorRef = inlineErrorRef([
      producerContractError({
        source: { kind: 'binding', bindAs: 'intent', producerTaskId: 'analyze-intent' },
      }),
    ]);
    const result = await tryRouteContractFailure(
      deps,
      baseArgs({
        workflow: workflow({
          onContractFailure: {
            perBinding: {
              draft: { producer: 'rerun', maxProducerReruns: 2 },
              intent: { producer: 'signal_blocked' },
            },
          },
        }),
        outcome: { kind: 'failed', errorRef },
      }),
    );
    expect(result).toEqual({ kind: 'paused' });
    expect(mockCommit).not.toHaveBeenCalled();
    expect((mockBuildContract.mock.calls[0]![0] as { pauseCause: string }).pauseCause).toBe(
      'task_contract_violation',
    );
    expect(mockPause.mock.calls[0]![6]).toBe('task_contract_violation');
  });

  it("producer:'fail' route → not_routed (caller fails the run as today)", async () => {
    const result = await tryRouteContractFailure(
      deps,
      baseArgs({
        workflow: workflow({ onContractFailure: { perBinding: { draft: { producer: 'fail' } } } }),
      }),
    );
    expect(result).toEqual({ kind: 'not_routed' });
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('non-attributable blame (platform) → not_routed', async () => {
    const errorRef = inlineErrorRef([
      {
        code: 'CONTRACT_INPUT_INVALID',
        consumerTaskId: 'validate-task-graph',
        contractName: 'draft',
        expectedSchema: {},
        zodIssues: [],
        blame: 'platform',
        source: { kind: 'platform' },
      },
    ]);
    const result = await tryRouteContractFailure(
      deps,
      baseArgs({ outcome: { kind: 'failed', errorRef } }),
    );
    expect(result).toEqual({ kind: 'not_routed' });
  });

  it('no onContractFailure on the consumer → not_routed', async () => {
    const result = await tryRouteContractFailure(
      deps,
      baseArgs({ workflow: workflow({ onContractFailure: undefined }) }),
    );
    expect(result).toEqual({ kind: 'not_routed' });
  });

  it('no errorRef → not_routed', async () => {
    const result = await tryRouteContractFailure(deps, baseArgs({ outcome: { kind: 'failed' } }));
    expect(result).toEqual({ kind: 'not_routed' });
  });

  it('producer already running (concurrent rerun) → subsumed (reran), no commit', async () => {
    const result = await tryRouteContractFailure(
      deps,
      baseArgs({ run: run({ status: 'running', attempt: 2 }) }),
    );
    expect(result).toEqual({ kind: 'reran' });
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("commit returns 'producer_not_resettable' → subsumed (reran), no dispatch", async () => {
    mockCommit.mockResolvedValue({ kind: 'producer_not_resettable' });
    const result = await tryRouteContractFailure(deps, baseArgs());
    expect(result).toEqual({ kind: 'reran' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatch failure after commit → defensively CASes the producer attempt to failed BEFORE failure propagation', async () => {
    // A PRE-claim dispatch throw leaves the re-armed producer `running` with no
    // worker; without the defensive CAS, applyFailureMode would only block
    // descendants and the run would never terminate (Plan 202 review fix).
    mockDispatch.mockRejectedValueOnce(new Error('buildTaskInputRef boom'));
    const result = await tryRouteContractFailure(deps, baseArgs());
    expect(result).toEqual({ kind: 'reran' });

    expect(mockCasComplete).toHaveBeenCalledTimes(1);
    const casArgs = mockCasComplete.mock.calls[0]![2] as Record<string, unknown>;
    expect(casArgs['taskId']).toBe('draft-task-graph');
    expect(casArgs['attempt']).toBe(2); // the re-armed attempt
    expect(casArgs['status']).toBe('failed');
    expect(casArgs['errorCode']).toBe('PRODUCER_RERUN_DISPATCH_FAILED');

    expect(mockApplyFailureMode).toHaveBeenCalledTimes(1);
    // Defensive failed-write happens BEFORE failure propagation.
    expect(mockCasComplete.mock.invocationCallOrder[0]!).toBeLessThan(
      mockApplyFailureMode.mock.invocationCallOrder[0]!,
    );
  });
});
