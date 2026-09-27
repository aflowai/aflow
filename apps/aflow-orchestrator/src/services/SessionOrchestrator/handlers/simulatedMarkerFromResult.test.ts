/**
 * The simulated marker follows what ran, not what was lowered.
 *
 * A binding's fulfillment can be re-pointed while the tool step it produced is
 * still sitting in the jobs stream, and the executor resolves fulfillment
 * again at call time. Reading the lowered step instead badges a live call as a
 * rehearsal when the promotion goes one way, and lets a rehearsal pass as
 * measured fact when it goes the other — and with no enforcement plane behind
 * it, the marker is the whole account a reader gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@aflow/redis';

const { completedEvents } = vi.hoisted(() => ({ completedEvents: [] as SessionEvent[] }));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    atomicCompleteStep: vi.fn(
      async (
        _redis: unknown,
        _tenantId: unknown,
        _stepUpdates: unknown,
        _runUpdates: unknown,
        events: SessionEvent | SessionEvent[],
      ) => {
        completedEvents.push(...(Array.isArray(events) ? events : [events]));
      },
    ),
    markRunInactive: vi.fn().mockResolvedValue(undefined),
    removeBarrierWatchdog: vi.fn().mockResolvedValue(undefined),
    setAppletFocus: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('./forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./enqueueDelegationCompletion.js', () => ({
  enqueuePendingAndReconcile: vi.fn().mockResolvedValue(undefined),
  isDelegationUpsertFailure: () => false,
}));

import type { AgentDefinition, StepDefinition } from '@aflow/schemas';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { applyStepSucceeded, type ApplyStepSucceededParams } from './applyStepSucceeded.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION = '22222222-2222-4222-9222-222222222222';
const STEP_EXEC = '33333333-3333-4333-9333-333333333333';
const NOW = 1_800_000_000_000;

/**
 * The step as it was lowered while the binding still named a simulation —
 * carrying every hint the old marker read: the binding tag, the simulated
 * dispatch tag, and a name that says which connection answered.
 */
const LOWERED_WHILE_SIMULATED: StepDefinition = {
  stepId: 'virtual_api_bnpl_createrefund_ab12cd34',
  stepType: 'api',
  operation: 'api.http.call',
  name: '↪ API bnpl-core.createRefund (bind_bnpl)',
  config: {},
  tags: [
    'dynamic',
    'virtual_api_tool',
    'parent:agent',
    '_toolId:api:bnpl-core/createRefund',
    '_bindingId:bind_bnpl',
    '_simulated',
  ],
  optional: false,
  outputOptions: { displayToUser: true },
  onSuccess: { next: [] },
  onFailure: { next: [] },
} as unknown as StepDefinition;

const payloadStore = {
  retrieve: async () => ({ refundId: 'rf_1', amount: 400 }),
  store: async () => 'inline:e30=',
} as unknown as PayloadStore;

function params(
  overrides: {
    simulatedFulfillment?: { bindingId: string; simulationId: string };
    nextStepId?: string;
  } = {},
): ApplyStepSucceededParams {
  const steps: StepDefinition[] = [
    overrides.nextStepId
      ? ({
          ...LOWERED_WHILE_SIMULATED,
          onSuccess: { next: [{ stepId: overrides.nextStepId, priority: 50 }] },
        } as StepDefinition)
      : LOWERED_WHILE_SIMULATED,
  ];
  if (overrides.nextStepId) {
    steps.push({
      stepId: overrides.nextStepId,
      stepType: 'memory',
      operation: 'memory.store.put',
      name: 'record',
      config: {},
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition);
  }

  const agentDef = {
    agentId: 'agent-1',
    name: 'refunds',
    version: '1',
    steps,
    startStepId: LOWERED_WHILE_SIMULATED.stepId,
    stateVariables: [],
  } as unknown as AgentDefinition;

  return {
    redis: {} as never,
    payloadStore,
    result: {
      tenantId: TENANT,
      sessionId: SESSION,
      stepId: LOWERED_WHILE_SIMULATED.stepId,
      stepExecutionId: STEP_EXEC,
      stepType: 'api',
      operationId: 'api.http.call',
      attempt: 1,
      outputRef: 'inline:e30=',
      traceId: 'trace-1',
      nowMs: NOW,
      ...(overrides.simulatedFulfillment
        ? { simulatedFulfillment: overrides.simulatedFulfillment }
        : {}),
    },
    runHotState: {
      tenantId: TENANT,
      sessionId: SESSION,
      status: 'RUNNING',
      variables: {},
    } as unknown as SessionHotState,
    stepDef: agentDef.steps[0] as StepDefinition,
    stepState: { stepExecutionId: STEP_EXEC, attempt: 1 } as unknown as StepHotState,
    agentDef,
    stepUpdates: { stepExecutionId: STEP_EXEC, startedAt: NOW - 1000 },
    currentRuntimeState: { version: 1, variables: {}, updatedAtMs: NOW },
    scheduleStep: vi.fn().mockResolvedValue(STEP_EXEC),
  };
}

function stepSucceededMeta(): Record<string, unknown> {
  const event = completedEvents.find((e) => e.eventType === 'StepSucceeded');
  if (!event) throw new Error('no StepSucceeded event was emitted');
  return (event.metadata ?? {}) as Record<string, unknown>;
}

describe('a binding promoted between lowering and dispatch', () => {
  beforeEach(() => {
    completedEvents.length = 0;
    vi.stubEnv('RECOVERY_EVENTS_ENABLED', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves the step unmarked when it was lowered simulated but ran live', async () => {
    await applyStepSucceeded(params());

    const meta = stepSucceededMeta();
    expect(meta['simulated']).toBeUndefined();
    expect(meta['simulatedBindingId']).toBeUndefined();
  });

  it('marks the step when it was lowered live but a simulation answered it', async () => {
    await applyStepSucceeded(
      params({ simulatedFulfillment: { bindingId: 'bind_bnpl', simulationId: 'sim_bnpl' } }),
    );

    const meta = stepSucceededMeta();
    expect(meta['simulated']).toBe(true);
    expect(meta['simulatedBindingId']).toBe('bind_bnpl');
  });

  it('answers the same way on the continuing path as on the terminal one', async () => {
    await applyStepSucceeded(
      params({
        nextStepId: 'record',
        simulatedFulfillment: { bindingId: 'bind_bnpl', simulationId: 'sim_bnpl' },
      }),
    );

    expect(stepSucceededMeta()['simulated']).toBe(true);

    completedEvents.length = 0;
    await applyStepSucceeded(params({ nextStepId: 'record' }));

    expect(stepSucceededMeta()['simulated']).toBeUndefined();
  });
});
