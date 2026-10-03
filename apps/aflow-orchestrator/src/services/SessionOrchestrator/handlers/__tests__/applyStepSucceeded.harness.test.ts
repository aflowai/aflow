import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAtomicCompleteStep = vi.fn();
const mockDecrementShardActiveRuns = vi.fn();
const mockRemoveBarrierWatchdog = vi.fn();
const mockShardFor = vi.fn().mockReturnValue('shard-0');

vi.mock('@aflow/redis', () => ({
  atomicCompleteStep: (...args: unknown[]) => mockAtomicCompleteStep(...args),
  markRunInactive: (...args: unknown[]) => mockDecrementShardActiveRuns(...args),
  shardFor: (...args: unknown[]) => mockShardFor(...args),
  removeBarrierWatchdog: (...args: unknown[]) => mockRemoveBarrierWatchdog(...args),
}));

vi.mock('@aflow/memory-paths', () => ({
  detectOutputFields: () => ['data'],
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  logOrchestratorError: vi.fn(),
}));

const mockBuildStepCompletedRecoveryEvents = vi.fn().mockResolvedValue([]);
vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildStepCompletedRecoveryEvents: (...args: unknown[]) =>
    mockBuildStepCompletedRecoveryEvents(...args),
}));

const mockApplyOutputMapping = vi.fn();
const mockBuildOutputVariables = vi.fn().mockReturnValue([]);
const mockAccumulateUsageSummary = vi.fn().mockReturnValue(undefined);
vi.mock('../../helpers/runtimeState.js', () => ({
  accumulateUsageSummary: (...args: unknown[]) => mockAccumulateUsageSummary(...args),
  applyOutputMapping: (...args: unknown[]) => mockApplyOutputMapping(...args),
  buildOutputVariables: (...args: unknown[]) => mockBuildOutputVariables(...args),
  readInlineVar: (_state: unknown, _key: string, fallback: unknown) => fallback,
  writeInlineVar: vi.fn(),
}));

const mockBuildToolResultSummary = vi.fn().mockReturnValue(undefined);
const mockBuildToolResultSummaryWithMeta = vi.fn().mockReturnValue({
  text: 'summary-text',
  meta: { kind: 'memory_read', chars: 12, continuationEmitted: true },
});
vi.mock('../../helpers/outputSummary.js', () => ({
  buildToolResultSummary: (...args: unknown[]) => mockBuildToolResultSummary(...args),
  buildToolResultSummaryWithMeta: (...args: unknown[]) =>
    mockBuildToolResultSummaryWithMeta(...args),
}));

vi.mock('../../helpers/aiHistory.js', () => ({
  isHistoryEnabled: () => false,
  loadOrCreateConversation: vi.fn(),
  storeConversation: vi.fn(),
}));

vi.mock('../../helpers/delegationState.js', () => ({
  getClearedDelegationStatePatch: () => ({}),
}));

const mockEnqueuePendingAndReconcile = vi.fn();
vi.mock('../enqueueDelegationCompletion.js', () => ({
  enqueuePendingAndReconcile: (...args: unknown[]) => mockEnqueuePendingAndReconcile(...args),
  isDelegationUpsertFailure: () => false,
}));

const mockRouteRunnerTerminalToHarness = vi.fn();
vi.mock('../../../cybernetic/WorkflowRunHarness.js', () => ({
  routeRunnerTerminalToHarness: (...args: unknown[]) => mockRouteRunnerTerminalToHarness(...args),
}));

vi.mock('../forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn(),
}));

// A fixture declaring an array path beside a single one, which no registered
// operation does.
const { IMAGE_FIXTURE_OPERATION } = vi.hoisted(() => ({
  IMAGE_FIXTURE_OPERATION: 'browser.page.screenshot_fixture',
}));
vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  const base = actual.getOperation('api.http.call')!;
  const fixture = {
    ...base,
    operationId: IMAGE_FIXTURE_OPERATION,
    stepType: 'browser',
    group: 'page',
    verb: 'screenshot_fixture',
    imageOutputPaths: ['image', 'frames[]'],
  };
  return {
    ...actual,
    getOperation: (id: string) =>
      id === IMAGE_FIXTURE_OPERATION ? fixture : actual.getOperation(id),
  };
});

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    tenantIdToSchemaName: (t: string) => `tenant_${t}`,
  };
});

import { toolResultMessage } from '@aflow/schemas';
import { applyStepSucceeded, type ApplyStepSucceededParams } from '../applyStepSucceeded.js';
import { buildToolResultEnvelopes } from '../../helpers/toolResultEnvelope.js';
import type { ToolResultSummary } from '../../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION_ID = 'runner-session-1';
const STEP_EXEC_ID = 'step-exec-1';

function makeAgentDefWithTerminalStep() {
  return {
    flowId: 'cybernetic-runner',
    schemaVersion: 1,
    metadata: { name: 'Runner', tags: ['system'] },
    stateVariables: [],
    startStepId: 'execute',
    steps: [
      {
        stepId: 'submit_output',
        stepType: 'agent',
        operation: 'agent.control.submit_output',
        name: 'Submit Output',
        config: {},
        tags: [],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
      },
    ],
  } as never;
}

function makeRuntimeState() {
  return { version: 1, variables: {}, updatedAtMs: 0 } as never;
}

function makeParams(
  overrides: {
    workflowExecution?: { runId: string; taskId: string; attempt: number };
    parentSessionId?: string;
    /** Pass `omitDb: true` to construct params without `db` (back-compat path). */
    omitDb?: boolean;
  } = {},
): ApplyStepSucceededParams {
  const runtimeState = makeRuntimeState();
  mockApplyOutputMapping.mockResolvedValue({
    updatedState: runtimeState,
    patch: { version: 1, changed: [] },
  });

  const runHotState = {
    sessionId: SESSION_ID,
    status: 'RUNNING',
    runtimeState,
    ...(overrides.workflowExecution ? { workflowExecution: overrides.workflowExecution } : {}),
    ...(overrides.parentSessionId ? { parentSessionId: overrides.parentSessionId } : {}),
  } as never;

  const params: ApplyStepSucceededParams = {
    redis: {} as never,
    payloadStore: {} as never,
    ...(overrides.omitDb ? {} : { db: {} as never }),
    result: {
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepId: 'submit_output',
      stepExecutionId: STEP_EXEC_ID,
      stepType: 'agent',
      operationId: 'agent.control.submit_output',
      attempt: 1,
      outputRef: 'inline:eyJyZXN1bHQiOnt9fQ==',
      traceId: 'trace-1',
      nowMs: 1_700_000_000_000,
    },
    runHotState,
    stepDef: {
      stepId: 'submit_output',
      stepType: 'agent',
      operation: 'agent.control.submit_output',
      name: 'Submit Output',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [{ stepId: 'execute', priority: 50 }] },
    } as never,
    stepState: { stepId: 'submit_output', startedAt: 1_700_000_000_000 } as never,
    agentDef: makeAgentDefWithTerminalStep(),
    stepUpdates: { stepExecutionId: STEP_EXEC_ID, startedAt: 1_700_000_000_000 } as never,
    currentRuntimeState: runtimeState,
    scheduleStep: vi.fn(),
  };

  return params;
}

describe('applyStepSucceeded — Runner-terminal harness intercept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAtomicCompleteStep.mockResolvedValue(undefined);
    mockDecrementShardActiveRuns.mockResolvedValue(undefined);
    mockRemoveBarrierWatchdog.mockResolvedValue(undefined);
    mockEnqueuePendingAndReconcile.mockResolvedValue(undefined);
    mockRouteRunnerTerminalToHarness.mockResolvedValue(undefined);
  });

  it('routes terminal SUCCEEDED to the harness when workflowExecution is set', async () => {
    await applyStepSucceeded(
      makeParams({
        workflowExecution: { runId: 'wfrun-1', taskId: 'task-A', attempt: 1 },
      }),
    );

    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
    expect(mockRouteRunnerTerminalToHarness).toHaveBeenCalledOnce();
    const [, runState, kind, payloads] = mockRouteRunnerTerminalToHarness.mock.calls[0]!;
    expect(runState).toMatchObject({
      tenantId: TENANT,
      workflowExecution: { runId: 'wfrun-1', taskId: 'task-A', attempt: 1 },
    });
    expect(kind).toBe('SUCCEEDED');
    expect(payloads).toMatchObject({ outputRef: 'inline:eyJyZXN1bHQiOnt9fQ==' });

    // Legacy parent delegation reconcile MUST NOT run for harness-spawned Runners.
    expect(mockEnqueuePendingAndReconcile).not.toHaveBeenCalled();
  });

  it('falls back to enqueuePendingAndReconcile for ordinary subflow runs', async () => {
    await applyStepSucceeded(
      makeParams({
        // No workflowExecution → ordinary subflow path.
        parentSessionId: 'parent-1',
      }),
    );

    expect(mockRouteRunnerTerminalToHarness).not.toHaveBeenCalled();
    expect(mockEnqueuePendingAndReconcile).toHaveBeenCalledOnce();
  });

  it('does not route to harness when db is undefined (back-compat guard)', async () => {
    await applyStepSucceeded(
      makeParams({
        workflowExecution: { runId: 'wfrun-2', taskId: 'task-B', attempt: 1 },
        omitDb: true,
      }),
    );

    expect(mockRouteRunnerTerminalToHarness).not.toHaveBeenCalled();
    expect(mockEnqueuePendingAndReconcile).toHaveBeenCalledOnce();
  });
});

describe('applyStepSucceeded — tool-result summary boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAtomicCompleteStep.mockResolvedValue(undefined);
    mockDecrementShardActiveRuns.mockResolvedValue(undefined);
    mockRemoveBarrierWatchdog.mockResolvedValue(undefined);
    mockBuildToolResultSummaryWithMeta.mockReturnValue({
      text: 'summary-text',
      meta: { kind: 'memory_read', chars: 12, continuationEmitted: true },
    });
  });

  it('passes the actual operation ID to the summary builder and stamps summary meta on the event', async () => {
    const runtimeState = { version: 1, variables: {}, updatedAtMs: 0 } as never;
    mockApplyOutputMapping.mockResolvedValue({
      updatedState: runtimeState,
      patch: { version: 1, changed: [] },
    });

    const toolStep = {
      stepId: 'read_output',
      stepType: 'memory',
      operation: 'memory.run_output.get',
      name: 'Read Run Output',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [{ stepId: 'agent_loop', priority: 50 }] },
      onFailure: { next: [] },
    };
    const agentStep = {
      stepId: 'agent_loop',
      stepType: 'ai',
      operation: 'ai.agent.turn',
      name: 'Agent Loop',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    };
    const agentDef = {
      flowId: 'flow-1',
      schemaVersion: 1,
      metadata: { name: 'Agent', tags: [] },
      stateVariables: [],
      startStepId: 'agent_loop',
      steps: [toolStep, agentStep],
    } as never;

    const readOutput = { stat: { path: '/run/outputs/api_0/data' }, data: 'body' };
    const params: ApplyStepSucceededParams = {
      redis: {} as never,
      payloadStore: { retrieve: vi.fn(async () => readOutput) } as never,
      db: {} as never,
      result: {
        tenantId: TENANT,
        sessionId: SESSION_ID,
        stepId: 'read_output',
        stepExecutionId: STEP_EXEC_ID,
        stepType: 'memory',
        operationId: 'memory.run_output.get',
        attempt: 1,
        outputRef: 'gs://bucket/output.json',
        traceId: 'trace-1',
        nowMs: 1_700_000_000_000,
      },
      runHotState: {
        sessionId: SESSION_ID,
        status: 'RUNNING',
        runtimeState,
        target: { kind: 'custom-agent' },
      } as never,
      stepDef: toolStep as never,
      stepState: {
        stepId: 'read_output',
        startedAt: 1_700_000_000_000,
        parentStepExecutionId: 'parent-exec-1',
      } as never,
      agentDef,
      stepUpdates: { stepExecutionId: STEP_EXEC_ID, startedAt: 1_700_000_000_000 } as never,
      currentRuntimeState: runtimeState,
      scheduleStep: vi.fn().mockResolvedValue('next-exec-1'),
    };

    await applyStepSucceeded(params);

    expect(mockBuildToolResultSummaryWithMeta).toHaveBeenCalled();
    const [, , operationId] = mockBuildToolResultSummaryWithMeta.mock.calls[0]! as unknown[];
    expect(operationId).toBe('memory.run_output.get');

    // The continue-path StepSucceeded event carries the compact summary meta.
    const [, , , , events] = mockAtomicCompleteStep.mock.calls[0]! as unknown[];
    const event = events as { metadata?: Record<string, unknown> };
    expect(event.metadata?.['toolSummary']).toEqual({
      kind: 'memory_read',
      chars: 12,
      continuationEmitted: true,
    });

    // The agent turn receives the summary text.
    const scheduled = (params.scheduleStep as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      lastToolResults?: Array<{ summary?: string; operationId?: string }>;
    };
    expect(scheduled.lastToolResults?.[0]?.summary).toBe('summary-text');
    expect(scheduled.lastToolResults?.[0]?.operationId).toBe('memory.run_output.get');
  });
});

describe('applyStepSucceeded — images in a tool output (Plan 320 D10)', () => {
  const ownRef = `gs://aflow-payloads/tenants/${TENANT}/runs/${SESSION_ID}/steps/${STEP_EXEC_ID}/attempt/1/body.json`;
  const screenshot = {
    ref: ownRef,
    contentType: 'image/png' as const,
    sizeBytes: 48_213,
    width: 1280,
    height: 720,
    description: 'The sign-in page',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAtomicCompleteStep.mockResolvedValue(undefined);
    mockDecrementShardActiveRuns.mockResolvedValue(undefined);
    mockRemoveBarrierWatchdog.mockResolvedValue(undefined);
    mockBuildToolResultSummaryWithMeta.mockReturnValue({
      text: 'summary-text',
      meta: { kind: 'generic', chars: 12, continuationEmitted: false },
    });
  });

  async function toolResultFor(
    operation: string,
    stepType: string,
    output: unknown,
  ): Promise<ToolResultSummary> {
    const runtimeState = { version: 1, variables: {}, updatedAtMs: 0 } as never;
    mockApplyOutputMapping.mockResolvedValue({
      updatedState: runtimeState,
      patch: { version: 1, changed: [] },
    });
    const step = (stepId: string, type: string, op: string, next: string[]) => ({
      stepId,
      stepType: type,
      operation: op,
      name: stepId,
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: next.map((n) => ({ stepId: n, priority: 50 })) },
      onFailure: { next: [] },
    });
    const toolStep = step('tool', stepType, operation, ['agent_loop']);
    const agentStep = step('agent_loop', 'ai', 'ai.agent.turn', []);
    const params: ApplyStepSucceededParams = {
      redis: {} as never,
      payloadStore: { retrieve: vi.fn(async () => output) } as never,
      db: {} as never,
      result: {
        tenantId: TENANT,
        sessionId: SESSION_ID,
        stepId: 'tool',
        stepExecutionId: STEP_EXEC_ID,
        stepType,
        operationId: operation,
        attempt: 1,
        outputRef: `gs://aflow-payloads/tenants/${TENANT}/runs/${SESSION_ID}/steps/${STEP_EXEC_ID}/attempt/1/output.json`,
        traceId: 'trace-1',
        nowMs: 1_700_000_000_000,
      },
      runHotState: {
        sessionId: SESSION_ID,
        status: 'RUNNING',
        runtimeState,
        target: { kind: 'custom-agent' },
      } as never,
      stepDef: toolStep as never,
      stepState: {
        stepId: 'tool',
        startedAt: 1_700_000_000_000,
        parentStepExecutionId: 'parent-exec-1',
      } as never,
      agentDef: {
        flowId: 'flow-1',
        schemaVersion: 1,
        metadata: { name: 'Agent', tags: [] },
        stateVariables: [],
        startStepId: 'agent_loop',
        steps: [toolStep, agentStep],
      } as never,
      stepUpdates: { stepExecutionId: STEP_EXEC_ID, startedAt: 1_700_000_000_000 } as never,
      currentRuntimeState: runtimeState,
      scheduleStep: vi.fn().mockResolvedValue('next-exec-1'),
    };
    await applyStepSucceeded(params);
    const scheduled = (params.scheduleStep as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      lastToolResults?: ToolResultSummary[];
    };
    const result = scheduled.lastToolResults?.[0];
    if (!result) throw new Error('expected a tool result for the agent turn');
    return result;
  }

  function messagePartsFor(result: ToolResultSummary) {
    const [envelope] = buildToolResultEnvelopes([result], 1_700_000_000_000);
    return toolResultMessage(envelope!).parts;
  }

  it('an api.http.call output holding a perfectly shaped image reaches the model as its JSON alone', async () => {
    const output = { status: 200, body: { image: screenshot, frames: [screenshot] } };
    const result = await toolResultFor('api.http.call', 'api', { image: screenshot, ...output });
    expect(result.images).toBeUndefined();
    expect(result.imagesWithheld).toBeUndefined();
    const parts = messagePartsFor(result);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.kind).toBe('json');
  });

  it("carries the image a declaring operation's step stored, at each declared path", async () => {
    const frame = { ...screenshot, description: 'The dashboard' };
    const result = await toolResultFor(IMAGE_FIXTURE_OPERATION, 'browser', {
      url: 'https://example.com',
      image: screenshot,
      frames: [frame],
      elsewhere: { ...screenshot, description: 'Not at a declared path' },
    });
    expect(result.images).toEqual([screenshot, frame]);
    expect(result.imagesWithheld).toBeUndefined();
    expect(messagePartsFor(result).slice(1)).toEqual([
      { kind: 'image', ...screenshot },
      { kind: 'image', ...frame },
    ]);
  });

  it.each([
    [
      'another step execution',
      `gs://aflow-payloads/tenants/${TENANT}/runs/${SESSION_ID}/steps/step-exec-2/attempt/1/body.json`,
    ],
    [
      'another run',
      `gs://aflow-payloads/tenants/${TENANT}/runs/other-session/steps/${STEP_EXEC_ID}/attempt/1/body.json`,
    ],
    [
      'another tenant',
      `gs://aflow-payloads/tenants/f0000000-0000-0000-0000-0000000000ff/runs/${SESSION_ID}/steps/${STEP_EXEC_ID}/attempt/1/body.json`,
    ],
    [
      'content-addressed bytes',
      `gs://aflow-payloads/tenants/${TENANT}/content/${'a'.repeat(64)}/body.json`,
    ],
  ])('carries no image whose reference names %s', async (_label, ref) => {
    const result = await toolResultFor(IMAGE_FIXTURE_OPERATION, 'browser', {
      image: { ...screenshot, ref },
    });
    expect(result.images).toBeUndefined();
    expect(result.imagesWithheld).toEqual([
      'The image at image was not shown: its reference names a payload this step did not store.',
    ]);
    const parts = messagePartsFor(result);
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts[0])).toContain('this step did not store');
  });

  describe('browser.page.screenshot, summarised by the real summariser', () => {
    beforeEach(async () => {
      const real = await vi.importActual<typeof import('../../helpers/outputSummary.js')>(
        '../../helpers/outputSummary.js',
      );
      mockBuildToolResultSummaryWithMeta.mockImplementation(real.buildToolResultSummaryWithMeta);
    });

    const shot = (image: typeof screenshot) => ({
      pageId: 'pg_1',
      url: 'https://example.com/login',
      image,
      receipt: { fullPage: false, retaken: false },
    });

    it('gives the next turn the image, and its text the description and size, never the reference', async () => {
      const result = await toolResultFor('browser.page.screenshot', 'browser', shot(screenshot));
      expect(result.images).toEqual([screenshot]);
      expect(result.summary).not.toContain(ownRef);
      const { ref: _ref, ...stub } = screenshot;
      expect(JSON.parse(result.summary!)).toMatchObject({ image: stub });
      const parts = messagePartsFor(result);
      expect(JSON.stringify(parts[0])).not.toContain(ownRef);
      expect(parts.slice(1)).toEqual([{ kind: 'image', ...screenshot }]);
    });

    it('shows a withheld image’s reference nowhere', async () => {
      const foreign = `gs://aflow-payloads/tenants/${TENANT}/runs/${SESSION_ID}/steps/step-exec-2/attempt/1/body.json`;
      const result = await toolResultFor(
        'browser.page.screenshot',
        'browser',
        shot({ ...screenshot, ref: foreign }),
      );
      expect(result.images).toBeUndefined();
      expect(JSON.stringify(messagePartsFor(result))).not.toContain(foreign);
    });
  });

  it('carries no image whose reference is inline', async () => {
    const inline = `inline:${Buffer.from('{"data":"iVBORw0KGgo=","mimeType":"image/png"}').toString('base64')}`;
    const result = await toolResultFor(IMAGE_FIXTURE_OPERATION, 'browser', {
      image: screenshot,
      frames: [{ ...screenshot, ref: inline }],
    });
    expect(result.images).toEqual([screenshot]);
    expect(result.imagesWithheld).toEqual([
      'The image at frames[0] was not shown: it is carried inline, not stored by this step.',
    ]);
  });
});
