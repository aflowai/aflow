import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  CompletionPolicy,
  SessionAgentTarget,
  SessionId,
  StepDefinition,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { AgentDefinitionSchema, getOperation } from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '@aflow/platform-artifacts';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { SessionEvent } from '@aflow/redis';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockAtomicCompleteStep = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockGetSessionState = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    atomicCompleteStep: (...args: unknown[]) => mockAtomicCompleteStep(...args),
    updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    registerBarrierWatchdog: vi.fn().mockResolvedValue(undefined),
    markRunInactive: vi.fn().mockResolvedValue(undefined),
    removeBarrierWatchdog: vi.fn().mockResolvedValue(undefined),
    shardFor: () => 'shard-0',
  };
});

const mockWaitForInput = vi.fn();
const mockFailStep = vi.fn();
vi.mock('../../../StepService/index.js', () => ({
  waitForInput: (...args: unknown[]) => mockWaitForInput(...args),
  completeStep: vi.fn(),
  failStep: (...args: unknown[]) => mockFailStep(...args),
}));

vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildStepCompletedRecoveryEvents: vi.fn().mockResolvedValue([]),
}));

const mockEnqueuePendingAndReconcile = vi.fn();
vi.mock('../enqueueDelegationCompletion.js', () => ({
  enqueuePendingAndReconcile: (...args: unknown[]) => mockEnqueuePendingAndReconcile(...args),
  isDelegationUpsertFailure: () => false,
}));

vi.mock('../forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../cybernetic/WorkflowRunHarness.js', () => ({
  routeRunnerTerminalToHarness: vi.fn().mockResolvedValue(undefined),
}));

const { applyAgentDecision, resolveCompletionSuccessor } = await import('../applyAgentDecision.js');
const { resolveStepInput } = await import('../../helpers/stepInputResolution.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION_ID = 'coach-session-1';
const STEP_EXEC_ID = 'sex-1' as StepExecutionId;
const NOW = 1_700_000_000_000;

function parsePlatformAgent(flowId: string): AgentDefinition {
  const raw = CYBERNETIC_AGENTS.find((a) => a.flowId === flowId);
  if (!raw) throw new Error(`platform agent ${flowId} not found`);
  return AgentDefinitionSchema.parse({ ...raw, version: '1' });
}

function makeCoachLikeAgentDef(): AgentDefinition {
  return {
    flowId: 'cybernetic-coach',
    schemaVersion: 1,
    metadata: { name: 'Coach', tags: ['system'] },
    stateVariables: [],
    startStepId: 'review',
    steps: [
      {
        stepId: 'review',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Coach',
        config: { agentRole: 'subagent', completionPolicy: 'must_complete_or_block' },
        tags: [],
        optional: false,
        onSuccess: { next: [{ stepId: 'validate-outcome', priority: 50 }] },
        onFailure: { next: [] },
      },
      {
        stepId: 'validate-outcome',
        stepType: 'learner',
        operation: 'learner.review.finalize',
        name: 'Validate Coach Outcome',
        config: { input: '${state.result}' },
        tags: [],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [{ stepId: 'review', priority: 50 }] },
      },
    ],
  } as unknown as AgentDefinition;
}

function makeRunnerLikeAgentDef(
  completionPolicy: CompletionPolicy = 'open_ended',
): AgentDefinition {
  return {
    flowId: 'cybernetic-runner',
    schemaVersion: 1,
    metadata: { name: 'Runner', tags: ['system'] },
    stateVariables: [],
    startStepId: 'execute',
    steps: [
      {
        stepId: 'execute',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Runner',
        config: { agentRole: 'subagent', completionPolicy },
        tags: [],
        optional: false,
        onSuccess: {
          next: [
            { stepId: 'submit_output', priority: 50 },
            { stepId: 'signal_blocked', priority: 50 },
          ],
        },
        onFailure: { next: [] },
      },
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
      {
        stepId: 'signal_blocked',
        stepType: 'agent',
        operation: 'agent.control.signal_blocked',
        name: 'Signal Blocked',
        config: {},
        tags: [],
        optional: false,
        onSuccess: { next: [{ stepId: 'execute', priority: 50 }] },
        onFailure: { next: [] },
      },
    ],
  } as unknown as AgentDefinition;
}

function makeClassicToolGraphAgentDef(): AgentDefinition {
  return {
    flowId: 'classic-agent',
    schemaVersion: 1,
    metadata: { name: 'Classic', tags: [] },
    stateVariables: [],
    startStepId: 'chat',
    steps: [
      {
        stepId: 'chat',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Chat',
        config: { agentRole: 'subagent' },
        tags: [],
        optional: false,
        onSuccess: { next: [{ stepId: 'lookup', priority: 50 }] },
        onFailure: { next: [] },
      },
      {
        stepId: 'lookup',
        stepType: 'memory',
        operation: 'memory.store.get',
        name: 'Lookup',
        config: {},
        tags: [],
        optional: false,
        onSuccess: { next: [{ stepId: 'chat', priority: 50 }] },
        onFailure: { next: [{ stepId: 'chat', priority: 50 }] },
      },
    ],
  } as unknown as AgentDefinition;
}

function makeMixedToolAndSuccessorAgentDef(): AgentDefinition {
  const def = makeCoachLikeAgentDef();
  const review = def.steps.find((s) => s.stepId === 'review');
  if (!review) throw new Error('review not found');
  review.onSuccess.next = [
    { stepId: 'lookup', priority: 90 },
    { stepId: 'validate-outcome', priority: 50 },
  ] as typeof review.onSuccess.next;
  def.steps.push({
    stepId: 'lookup',
    stepType: 'memory',
    operation: 'memory.store.get',
    name: 'Lookup',
    config: {},
    tags: [],
    optional: false,
    onSuccess: { next: [{ stepId: 'review', priority: 50 }] },
    onFailure: { next: [{ stepId: 'review', priority: 50 }] },
  } as unknown as StepDefinition);
  return def;
}

function makeSingleStepSubagentDef(): AgentDefinition {
  return {
    flowId: 'delegate-child',
    schemaVersion: 1,
    metadata: { name: 'Delegate Child', tags: [] },
    stateVariables: [],
    startStepId: 'work',
    steps: [
      {
        stepId: 'work',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Work',
        config: { agentRole: 'subagent', completionPolicy: 'must_complete_or_block' },
        tags: [],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
    ],
  } as unknown as AgentDefinition;
}

function makePayloadStore() {
  const mem = new Map<string, unknown>();
  let counter = 0;
  return {
    mem,
    store: vi.fn(async (params: { data: unknown }) => {
      counter += 1;
      const ref = `mem:${String(counter)}`;
      mem.set(ref, params.data);
      return ref;
    }),
    retrieve: vi.fn(async (ref: string) => {
      if (mem.has(ref)) return mem.get(ref);
      if (ref.startsWith('inline:')) {
        return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8'));
      }
      throw new Error(`missing payload ${ref}`);
    }),
  };
}

function encodeAgentTurnOutput(decision: Record<string, unknown>): string {
  const envelope = {
    decision,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: 'test-model',
    turnNumber: 2,
  };
  return `inline:${Buffer.from(JSON.stringify(envelope)).toString('base64')}`;
}

function makeParams(opts: {
  agentDef: AgentDefinition;
  stepId: string;
  decision: Record<string, unknown>;
  target?: SessionAgentTarget;
  /** Override for tests that need real payload-path derivation. */
  payloadStore?: unknown;
}) {
  const payloadStore = (opts.payloadStore ?? makePayloadStore()) as ReturnType<
    typeof makePayloadStore
  >;
  const stepDef = opts.agentDef.steps.find((s) => s.stepId === opts.stepId);
  if (!stepDef) throw new Error(`step ${opts.stepId} not found`);
  const runtimeState = { schemaVersion: 1 as const, variables: {}, version: 0, updatedAtMs: NOW };
  const outputRef = encodeAgentTurnOutput(opts.decision);
  const scheduleStep = vi.fn().mockResolvedValue('sex-next' as StepExecutionId);

  return {
    payloadStore,
    scheduleStep,
    params: {
      redis: {} as never,
      payloadStore: payloadStore as never,
      result: {
        tenantId: TENANT,
        sessionId: SESSION_ID,
        stepId: opts.stepId,
        stepExecutionId: STEP_EXEC_ID,
        stepType: 'ai',
        operationId: 'ai.agent.turn',
        attempt: 1,
        outputRef,
        traceId: 'trace-1',
        nowMs: NOW,
      },
      runHotState: {
        sessionId: SESSION_ID,
        status: 'RUNNING',
        target:
          opts.target ??
          ({ kind: 'platform-role', systemRole: 'cybernetic-coach' } as SessionAgentTarget),
        runtimeState,
      } as never,
      stepDef,
      stepState: { stepId: opts.stepId, stepExecutionId: STEP_EXEC_ID, startedAt: NOW } as never,
      agentDef: opts.agentDef,
      stepUpdates: {
        stepExecutionId: STEP_EXEC_ID,
        status: 'SUCCEEDED' as const,
        endedAt: NOW,
        outputRef,
      },
      currentRuntimeState: runtimeState,
      scheduleStep,
    },
  };
}

const COMPLETE_DECISION = {
  action: 'complete',
  result: { outcome: 'silent', rationale: 'clean run, nothing to record this review' },
  message: 'Review complete.',
};

beforeEach(() => {
  mockAtomicCompleteStep.mockReset().mockResolvedValue(undefined);
  mockUpdateSessionState.mockReset().mockResolvedValue(undefined);
  mockGetSessionState.mockReset().mockResolvedValue(undefined);
  mockWaitForInput.mockReset().mockResolvedValue(undefined);
  mockFailStep.mockReset().mockResolvedValue(undefined);
  mockEnqueuePendingAndReconcile.mockReset().mockResolvedValue(undefined);
});

// ── resolveCompletionSuccessor — real platform graphs ───────────────────────

describe('resolveCompletionSuccessor — real platform graphs', () => {
  it('Coach review step completes into validate-outcome', () => {
    const coach = parsePlatformAgent('cybernetic-coach');
    const review = coach.steps.find((s) => s.stepId === 'review');
    expect(review).toBeDefined();
    expect(review?.config['completionPolicy']).toBe('must_complete_or_block');
    expect(resolveCompletionSuccessor(review, coach, 'must_complete_or_block')).toBe(
      'validate-outcome',
    );
  });

  it('Runner execute step keeps complete-as-terminal (open_ended — terminal tools are not successors)', () => {
    const runner = parsePlatformAgent('cybernetic-runner');
    const execute = runner.steps.find((s) => s.stepId === 'execute');
    expect(execute).toBeDefined();
    const policy = execute?.config['completionPolicy'] as CompletionPolicy;
    expect(policy).toBe('open_ended');
    expect(resolveCompletionSuccessor(execute, runner, policy)).toBeNull();
  });

  it('Helmsman chat step keeps complete-as-terminal (open_ended assistant)', () => {
    const helmsman = parsePlatformAgent('cybernetic-helmsman');
    const chat = helmsman.steps.find((s) => s.operation === 'ai.agent.turn');
    expect(chat).toBeDefined();
    const policy = chat?.config['completionPolicy'] as CompletionPolicy;
    expect(policy).toBe('open_ended');
    expect(resolveCompletionSuccessor(chat, helmsman, policy)).toBeNull();
  });
});

// ── resolveCompletionSuccessor — shape discrimination ───────────────────────

describe('resolveCompletionSuccessor — shape discrimination', () => {
  it('returns null when the graph declares no onSuccess edge', () => {
    const def = makeSingleStepSubagentDef();
    const work = def.steps.find((s) => s.stepId === 'work');
    expect(resolveCompletionSuccessor(work, def, 'must_complete_or_block')).toBeNull();
  });

  it('returns null for tool edges that route back to the agent step', () => {
    const def = makeClassicToolGraphAgentDef();
    const chat = def.steps.find((s) => s.stepId === 'chat');
    expect(resolveCompletionSuccessor(chat, def, 'must_complete_or_block')).toBeNull();
  });

  it('returns null for policies other than must_complete_or_block', () => {
    const def = makeCoachLikeAgentDef();
    const review = def.steps.find((s) => s.stepId === 'review');
    expect(resolveCompletionSuccessor(review, def, 'allowed')).toBeNull();
    expect(resolveCompletionSuccessor(review, def, 'open_ended')).toBeNull();
  });

  it('Runner-shaped graph under must_complete_or_block keeps complete-as-terminal (terminal agent verbs are tools, not successors)', () => {
    const def = makeRunnerLikeAgentDef('must_complete_or_block');
    const execute = def.steps.find((s) => s.stepId === 'execute');
    expect(resolveCompletionSuccessor(execute, def, 'must_complete_or_block')).toBeNull();
  });

  it('a route-back tool edge outranking the successor does not shadow it', () => {
    const def = makeMixedToolAndSuccessorAgentDef();
    const review = def.steps.find((s) => s.stepId === 'review');
    expect(resolveCompletionSuccessor(review, def, 'must_complete_or_block')).toBe(
      'validate-outcome',
    );
  });

  it('returns null when stepDef is undefined or the successor is missing from the graph', () => {
    const def = makeCoachLikeAgentDef();
    expect(resolveCompletionSuccessor(undefined, def, 'must_complete_or_block')).toBeNull();
    const dangling = {
      ...def.steps.find((s) => s.stepId === 'review'),
      onSuccess: { next: [{ stepId: 'not-a-step', priority: 50 }] },
    } as unknown as StepDefinition;
    expect(resolveCompletionSuccessor(dangling, def, 'must_complete_or_block')).toBeNull();
  });
});

// ── applyAgentDecision — complete routes through the graph ──────────────────

describe('applyAgentDecision — contract-bound complete schedules the graph successor', () => {
  it('Coach-shaped complete schedules validate-outcome instead of ending the session', async () => {
    const { params, payloadStore, scheduleStep } = makeParams({
      agentDef: makeCoachLikeAgentDef(),
      stepId: 'review',
      decision: COMPLETE_DECISION,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).toHaveBeenCalledOnce();
    const scheduled = scheduleStep.mock.calls[0]?.[0] as { stepId: string; inputRef: string };
    expect(scheduled.stepId).toBe('validate-outcome');
    // The successor's raw input is the stored complete.result payload — the
    // outcome object the finalize op validates at top level.
    expect(payloadStore.mem.get(scheduled.inputRef)).toEqual(COMPLETE_DECISION.result);

    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
    const runUpdates = mockAtomicCompleteStep.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(runUpdates['status']).toBeUndefined();

    const events = mockAtomicCompleteStep.mock.calls[0]?.[4] as SessionEvent | SessionEvent[];
    const eventList = Array.isArray(events) ? events : [events];
    expect(eventList.map((e) => e.eventType)).toEqual(['StepSucceeded']);
    expect(eventList.some((e) => e.eventType === 'SessionCompleted')).toBe(false);

    // The complete.result must be visible to the successor as ${state.result}.
    const runtimeState = runUpdates['runtimeState'] as {
      variables: Record<string, { ref: { kind: string; payloadRef?: string } }>;
    };
    expect(runtimeState.variables['result']?.ref.payloadRef).toBe(scheduled.inputRef);

    // Session is still running — no parent resume yet.
    expect(mockEnqueuePendingAndReconcile).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('a route-back tool edge outranking the successor never wins the executed route', async () => {
    const { params, scheduleStep } = makeParams({
      agentDef: makeMixedToolAndSuccessorAgentDef(),
      stepId: 'review',
      decision: COMPLETE_DECISION,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).toHaveBeenCalledOnce();
    const scheduled = scheduleStep.mock.calls[0]?.[0] as { stepId: string };
    expect(scheduled.stepId).toBe('validate-outcome');
  });

  it('subagent complete with no successor stays session-terminal (delegate children)', async () => {
    const { params, scheduleStep } = makeParams({
      agentDef: makeSingleStepSubagentDef(),
      stepId: 'work',
      decision: COMPLETE_DECISION,
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).not.toHaveBeenCalled();
    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
    const runUpdates = mockAtomicCompleteStep.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(runUpdates['status']).toBe('SUCCEEDED');
    const events = mockAtomicCompleteStep.mock.calls[0]?.[4] as SessionEvent[];
    expect(events.map((e) => e.eventType)).toEqual(['StepSucceeded', 'SessionCompleted']);
    expect(mockEnqueuePendingAndReconcile).toHaveBeenCalledOnce();
  });

  it('Runner-shaped open_ended complete never schedules its terminal tools as successors', async () => {
    const { params, scheduleStep } = makeParams({
      agentDef: makeRunnerLikeAgentDef(),
      stepId: 'execute',
      decision: COMPLETE_DECISION,
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).not.toHaveBeenCalled();
    const events = mockAtomicCompleteStep.mock.calls[0]?.[4] as SessionEvent[];
    expect(events.some((e) => e.eventType === 'SessionCompleted')).toBe(true);
  });

  it('Runner-shaped complete stays session-terminal even under the default contract policy', async () => {
    const { params, scheduleStep } = makeParams({
      agentDef: makeRunnerLikeAgentDef('must_complete_or_block'),
      stepId: 'execute',
      decision: COMPLETE_DECISION,
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).not.toHaveBeenCalled();
    const events = mockAtomicCompleteStep.mock.calls[0]?.[4] as SessionEvent[];
    expect(events.some((e) => e.eventType === 'SessionCompleted')).toBe(true);
  });

  it('the scheduled successor input validates against the finalize contract', async () => {
    const payloadStore = makePayloadStore();
    const resultRef = (await payloadStore.store({
      data: COMPLETE_DECISION.result,
    } as never)) as string;
    const runtimeState = {
      schemaVersion: 1 as const,
      version: 1,
      updatedAtMs: NOW,
      variables: {
        result: {
          ref: { kind: 'ref', payloadRef: resultRef },
          updatedAtMs: NOW,
          updatedBy: { actor: 'orchestrator', stepId: 'review', stepExecutionId: STEP_EXEC_ID },
          version: 1,
        },
      },
    };
    const def = makeCoachLikeAgentDef();
    const validateStep = def.steps.find((s) => s.stepId === 'validate-outcome');
    if (!validateStep) throw new Error('validate-outcome not found');

    const resolvedRef = await resolveStepInput(
      payloadStore as never,
      validateStep,
      resultRef,
      runtimeState as never,
    );
    const resolved = await payloadStore.retrieve(resolvedRef);

    const finalizeOp = getOperation('learner.review.finalize');
    expect(finalizeOp).toBeDefined();
    const parsed = finalizeOp?.inputZod.safeParse(resolved);
    expect(parsed?.success).toBe(true);
    expect(resolved).toMatchObject({ outcome: 'silent' });
  });

  it('the complete.result spill never shares a payload path with the conversation state', async () => {
    const memStore = createMemoryPayloadStore();
    const conversationState = {
      schemaVersion: 1,
      conversationId: `${TENANT}:${SESSION_ID}:review`,
      turnNumber: 3,
      context: {},
      history: { atoms: [], maxAtomsStructural: 60 },
      seenSourceIds: {},
    };
    // The executor persists conversation state for the SAME agent-turn step +
    // attempt under kind 'state'.
    const conversationRef = await memStore.store({
      tenantId: TENANT as TenantId,
      runId: SESSION_ID as SessionId,
      stepExecutionId: STEP_EXEC_ID,
      attempt: 1,
      kind: 'state',
      data: conversationState,
    });

    const { params, scheduleStep } = makeParams({
      agentDef: makeCoachLikeAgentDef(),
      stepId: 'review',
      decision: COMPLETE_DECISION,
      payloadStore: memStore,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    const scheduled = scheduleStep.mock.calls[0]?.[0] as { stepId: string; inputRef: string };
    expect(scheduled.stepId).toBe('validate-outcome');
    expect(scheduled.inputRef).not.toBe(conversationRef);
    expect(scheduled.inputRef).toContain('/state_variable.json');
    expect(await memStore.retrieve(scheduled.inputRef as never)).toEqual(COMPLETE_DECISION.result);
    expect(await memStore.retrieve(conversationRef)).toEqual(conversationState);
  });

  it('a stringified complete.result is decoded at the seam and satisfies the finalize contract end-to-end', async () => {
    const { params, payloadStore, scheduleStep } = makeParams({
      agentDef: makeCoachLikeAgentDef(),
      stepId: 'review',
      decision: {
        action: 'complete',
        result: JSON.stringify(COMPLETE_DECISION.result, null, 2),
        message: 'Review complete.',
      },
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    const scheduled = scheduleStep.mock.calls[0]?.[0] as { stepId: string; inputRef: string };
    expect(scheduled.stepId).toBe('validate-outcome');
    expect(payloadStore.mem.get(scheduled.inputRef)).toEqual(COMPLETE_DECISION.result);

    // Full seam: resolve the successor's input from the spilled payload and
    // the persisted runtime state, exactly as scheduling does, then validate
    // against the finalize operation contract.
    const runUpdates = mockAtomicCompleteStep.mock.calls[0]?.[3] as {
      runtimeState: Record<string, unknown>;
    };
    const validateStep = makeCoachLikeAgentDef().steps.find((s) => s.stepId === 'validate-outcome');
    if (!validateStep) throw new Error('validate-outcome not found');
    const resolvedRef = await resolveStepInput(
      payloadStore as never,
      validateStep,
      scheduled.inputRef,
      runUpdates.runtimeState as never,
    );
    const resolved = await payloadStore.retrieve(resolvedRef);
    const finalizeOp = getOperation('learner.review.finalize');
    expect(finalizeOp?.inputZod.safeParse(resolved).success).toBe(true);
  });

  it('a non-JSON string complete.result loops back with teaching feedback and is never persisted', async () => {
    const proseResult = 'I reviewed the run and everything looks good.';
    const { params, payloadStore, scheduleStep } = makeParams({
      agentDef: makeCoachLikeAgentDef(),
      stepId: 'review',
      decision: { action: 'complete', result: proseResult, message: 'done' },
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    const scheduled = scheduleStep.mock.calls[0]?.[0] as { stepId: string };
    expect(scheduled.stepId).toBe('review');
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
    expect([...payloadStore.mem.values()]).not.toContain(proseResult);

    const patch = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, { ref?: { value?: unknown } }> };
    };
    expect(patch.runtimeState.variables['ai.agent.chatInput.review']?.ref?.value).toContain(
      '[COMPLETION CONTRACT]',
    );
    expect(patch.runtimeState.variables['ai.agent.outputContractRetries.review']?.ref?.value).toBe(
      1,
    );
  });

  it('a persistently malformed complete.result fails the step after the retry budget', async () => {
    const { params, scheduleStep } = makeParams({
      agentDef: makeCoachLikeAgentDef(),
      stepId: 'review',
      decision: { action: 'complete', result: 'still not JSON', message: 'done' },
    });
    (params.currentRuntimeState.variables as Record<string, unknown>)[
      'ai.agent.outputContractRetries.review'
    ] = {
      ref: { kind: 'inline', value: 5 },
      updatedAtMs: NOW,
      updatedBy: { actor: 'orchestrator', stepId: 'review', stepExecutionId: STEP_EXEC_ID },
      version: 5,
    };

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(scheduleStep).not.toHaveBeenCalled();
    expect(mockFailStep).toHaveBeenCalledOnce();
    const error = mockFailStep.mock.calls[0]?.[2] as { code: string };
    expect(error.code).toBe('COMPLETION_RESULT_MALFORMED_PERSISTENT');
  });

  it('a plain-string complete.result stays a string when no successor is bound', async () => {
    const proseResult = 'the drafted paragraph the parent asked for';
    const { params, payloadStore } = makeParams({
      agentDef: makeSingleStepSubagentDef(),
      stepId: 'work',
      decision: { action: 'complete', result: proseResult, message: 'done' },
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
    expect([...payloadStore.mem.values()]).toContain(proseResult);
  });

  it('a valid decision clears the invalid-decision retry budget (agentDecisionRecovery)', async () => {
    const { params } = makeParams({
      agentDef: makeSingleStepSubagentDef(),
      stepId: 'work',
      decision: { action: 'complete', result: { ok: true }, message: 'done' },
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' } as SessionAgentTarget,
    });
    (params.currentRuntimeState.variables as Record<string, unknown>)[
      'ai.agent.invalidDecisionRetries.work'
    ] = {
      ref: { kind: 'inline', value: 2 },
      updatedAtMs: NOW,
      updatedBy: { actor: 'orchestrator', stepId: 'work', stepExecutionId: STEP_EXEC_ID },
      version: 2,
    };

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    const runUpdates = mockAtomicCompleteStep.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, unknown> };
    };
    expect(
      runUpdates.runtimeState.variables['ai.agent.invalidDecisionRetries.work'],
    ).toBeUndefined();
  });

  it('assistant complete keeps the unified pause path (Helmsman)', async () => {
    const helmsmanLike = {
      ...makeCoachLikeAgentDef(),
      steps: [
        {
          stepId: 'chat',
          stepType: 'ai',
          operation: 'ai.agent.turn',
          name: 'Helmsman',
          config: { agentRole: 'assistant', completionPolicy: 'open_ended' },
          tags: [],
          optional: false,
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    } as unknown as AgentDefinition;

    const { params, scheduleStep } = makeParams({
      agentDef: helmsmanLike,
      stepId: 'chat',
      decision: COMPLETE_DECISION,
      target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' } as SessionAgentTarget,
    });

    const handled = await applyAgentDecision(params as never);
    expect(handled).toBe(true);

    expect(mockWaitForInput).toHaveBeenCalledOnce();
    expect(scheduleStep).not.toHaveBeenCalled();
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
  });
});
