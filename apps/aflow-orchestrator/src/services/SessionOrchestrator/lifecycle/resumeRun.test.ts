import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionStateSafe = vi.fn();
const mockGetStepState = vi.fn();
const mockAtomicCompleteStep = vi.fn();
vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    isSessionCorrupt: vi.fn().mockResolvedValue(false),
    getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
    getStepState: (...args: unknown[]) => mockGetStepState(...args),
    atomicCompleteStep: (...args: unknown[]) => mockAtomicCompleteStep(...args),
    takeRoomMessagePosition: vi.fn().mockResolvedValue(1),
    updateSessionState: vi.fn().mockResolvedValue(undefined),
    updateStepState: vi.fn().mockResolvedValue(undefined),
    addStepResult: vi.fn().mockResolvedValue(undefined),
  };
});

const mockQueueMessage = vi.fn();
vi.mock('../helpers/queuedMessage.js', async () => {
  const actual = await vi.importActual<typeof import('../helpers/queuedMessage.js')>(
    '../helpers/queuedMessage.js',
  );
  return {
    ...actual,
    queueMessageForNextTurn: (...args: unknown[]) => mockQueueMessage(...args),
  };
});

const AGENT_STEP = 'ai-1';
const CHAT_INPUT = `ai.agent.chatInput.${AGENT_STEP}`;
const mockAgentDef = vi.fn();
vi.mock('../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: (...args: unknown[]) => mockAgentDef(...args),
}));
vi.mock('../helpers/recoveryEmitter.js', () => ({
  buildRunStatusChangedRecoveryEvent: vi.fn().mockResolvedValue([]),
}));

import { createResumeRun } from './resumeRun.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as never;
const SESSION = '99999999-2222-3333-4444-555555555555' as never;
const STEP = '00000000-0000-4000-8000-0000000000a1' as never;
const CHILD_RUN = '11111111-2222-3333-4444-555555555555';

/** Payloads by reference: a resume's input, and the pause's own payload. */
const payloads = new Map<string, unknown>();
const scheduleStep = vi.fn();

const resumeRun = createResumeRun({
  deps: {
    db: {},
    redis: {},
    payloadStore: {
      retrieve: vi.fn(async (ref: string) => {
        const payload = payloads.get(ref);
        if (payload instanceof Error) throw payload;
        return payload;
      }),
    },
  },
  scheduleStep,
} as never);

const PERSON = {
  userId: '0f0e0d0c-1111-4222-8333-444455556666',
  displayName: 'Ada',
  tenantId: TENANT,
} as never;

function resume(input: unknown = {}, extra: Record<string, unknown> = {}) {
  const inputRef = `ref:input:${String(payloads.size)}`;
  payloads.set(inputRef, input);
  return resumeRun({
    tenantId: TENANT,
    runId: SESSION,
    stepExecutionId: STEP,
    inputRef: inputRef as never,
    traceId: 'trace-1' as never,
    idempotencyKey: 'idem-1' as never,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  payloads.clear();
  mockAgentDef.mockResolvedValue({
    steps: [
      { stepId: AGENT_STEP, operation: 'ai.agent.turn', stepType: 'ai', config: {} },
      { stepId: 'ask-1', operation: 'user.interaction.approve', stepType: 'user', config: {} },
    ],
    stateVariables: [
      {
        variableId: 'topic',
        name: 'Topic',
        lifecycle: { isInput: true, isOutput: false },
        required: false,
      },
    ],
  });
});

describe('resumeRun on a session parked on a workflow run', () => {
  it('refuses, naming the run and the ways to stop waiting on it', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: {
        status: 'PAUSED',
        currentStepExecutionId: STEP,
        pauseType: 'external_dependency',
        waitingOnWorkflowRunId: CHILD_RUN,
      },
    });

    const refusal = await resume().catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ControlConflictError);
    const conflict = refusal as ControlConflictError;
    expect(conflict.conflictCode).toBe('run_waiting_on_workflow_run');
    expect(conflict.message).toContain(CHILD_RUN);
    expect(conflict.message).toContain('workflow.run.cancel');
    expect(conflict.message).toContain('interruptRun');
    expect(mockGetStepState).not.toHaveBeenCalled();
  });

  it('lets a session paused for an operator through the guard', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { status: 'PAUSED', currentStepExecutionId: STEP, pauseType: 'user_input' },
    });
    mockGetStepState.mockResolvedValue(null);

    await expect(resume()).rejects.toThrow(/not found in Redis/);
    expect(mockGetStepState).toHaveBeenCalledOnce();
  });
});

describe('resumeRun on a conversation waiting on a paused workflow run', () => {
  const parked = {
    status: 'PAUSED',
    currentStepExecutionId: STEP,
    pauseType: 'external_dependency',
    waitingOnWorkflowRunId: CHILD_RUN,
  };

  it('takes a message: queued to the turn the run wakes, and the conversation goes on waiting', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: parked });
    mockQueueMessage.mockResolvedValue({ eventId: 'event-1', messageSeq: 4 });

    const outcome = await resume('Also bump the version while you are there.', {
      actorContext: PERSON,
      clientMessageId: 'client-1',
    });

    expect(outcome).toEqual({ status: 'PAUSED' });
    expect(mockQueueMessage).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({
        tenantId: TENANT,
        sessionId: SESSION,
        deliveryKey: 'idem-1',
        actorUserId: '0f0e0d0c-1111-4222-8333-444455556666',
        actorDisplayName: 'Ada',
        body: 'Also bump the version while you are there.',
        clientMessageId: 'client-1',
      }),
    );
    // The parked step is the run's waiter's to complete; nothing here touches it.
    expect(mockGetStepState).not.toHaveBeenCalled();
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
  });

  it('reads the message in every shape a conversation is sent one', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: parked });
    mockQueueMessage.mockResolvedValue({ eventId: 'event-1', messageSeq: 4 });
    for (const input of [{ input: 'Go on.' }, { [CHAT_INPUT]: 'Go on.' }]) {
      await expect(resume(input, { actorContext: PERSON })).resolves.toEqual({
        status: 'PAUSED',
      });
    }
    expect(mockQueueMessage.mock.calls.map((call) => (call[2] as { body: string }).body)).toEqual([
      'Go on.',
      'Go on.',
    ]);
  });

  it('stays paused, not failed, when the message is live but its durable row is owed', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: parked });
    mockQueueMessage.mockResolvedValue({ eventId: 'event-1', durableOwed: true });

    // ControlConsumer fails a run only on a throw; this resolves.
    await expect(resume('Go on.', { actorContext: PERSON })).resolves.toEqual({
      status: 'PAUSED',
    });
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
  });

  it('refuses a resume carrying no message, saying it carried none', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: parked });
    for (const attempt of [
      resume({}, { actorContext: PERSON }),
      resume({ unrelated: true }, { actorContext: PERSON }),
      resume({}, { actorContext: PERSON, inputRef: undefined }),
    ]) {
      const refusal = (await attempt.catch((err: unknown) => err)) as ControlConflictError;
      expect(refusal.conflictCode).toBe('run_waiting_on_workflow_run');
      expect(refusal.message).toContain('this resume carried none');
    }
    expect(mockQueueMessage).not.toHaveBeenCalled();
  });

  it('refuses a resume that did carry text by naming what failed, not "carried none"', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: parked });
    mockQueueMessage.mockResolvedValue(undefined);
    const cases: Array<[Promise<unknown>, RegExp]> = [
      [resume('A message from nobody.'), /no person to attribute it to/],
      [
        resume(new Error('bucket unreachable'), { actorContext: PERSON }),
        /could not be read from the payload store \(bucket unreachable\)/,
      ],
      [resume('Hello?', { actorContext: PERSON }), /live state is gone/],
    ];
    for (const [attempt, reason] of cases) {
      const refusal = (await attempt.catch((err: unknown) => err)) as ControlConflictError;
      expect(refusal.conflictCode).toBe('run_waiting_on_workflow_run');
      expect(refusal.message).toMatch(reason);
      expect(refusal.message).not.toContain('carried none');
    }
    expect(mockQueueMessage).toHaveBeenCalledOnce();
  });
});

describe('resumeRun refuses an input that maps to nothing', () => {
  const PAUSE_REF = 'ref:pause';

  function pausedAt(contract: unknown, stepId = AGENT_STEP) {
    if (contract === undefined) payloads.delete(PAUSE_REF);
    else payloads.set(PAUSE_REF, { resumeContract: contract });
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: {
        status: 'PAUSED',
        currentStepExecutionId: STEP,
        pauseType: 'user_input',
        ...(contract === undefined ? {} : { requestedInputRef: PAUSE_REF }),
        runtimeState: { variables: {}, version: 1, updatedAtMs: 0 },
      },
    });
    mockGetStepState.mockResolvedValue({
      stepId,
      stepType: 'ai',
      attempt: 1,
      status: 'PAUSED',
      inputRef: 'ref:step-input',
    });
  }

  const chatContract = {
    reason: 'input_required',
    mode: 'primary',
    stepId: AGENT_STEP,
    targetVariableId: CHAT_INPUT,
    requiredFields: [{ variableId: CHAT_INPUT, name: 'Message' }],
  };

  async function refusalOf(input: unknown): Promise<ControlConflictError> {
    const refusal = await resume(input).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ControlConflictError);
    return refusal as ControlConflictError;
  }

  it('refuses an object naming none of the contract variables, naming the shape the pause takes', async () => {
    pausedAt(chatContract);
    const refusal = await refusalOf({ message: 'Ship it.' });
    expect(refusal.conflictCode).toBe('resume_input_unmapped');
    expect(refusal.message).toContain('{ "input": "<message>" }');
    expect(refusal.message).toContain(CHAT_INPUT);
    expect(refusal.message).toContain('still paused');
    // Refused before the transition: the run never left its pause.
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
    expect(scheduleStep).not.toHaveBeenCalled();
  });

  it('refuses fields that are none of the ones a fields pause takes, naming each', async () => {
    pausedAt({
      reason: 'input_required',
      mode: 'fields',
      stepId: AGENT_STEP,
      requiredFields: [{ variableId: 'topic' }, { variableId: 'audience' }],
    });
    const refusal = await refusalOf({ input: { subject: 'x' } });
    expect(refusal.conflictCode).toBe('resume_input_unmapped');
    expect(refusal.message).toContain('{ "input": { "topic": <value>, "audience": <value> } }');
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
  });

  it('refuses, on a pause with no contract, an object whose keys match no variable and that says nothing', async () => {
    pausedAt(undefined);
    const refusal = await refusalOf({ nothingThisPauseTakes: 1 });
    expect(refusal.conflictCode).toBe('resume_input_unmapped');
    expect(refusal.message).toContain('`topic`');
    expect(mockAtomicCompleteStep).not.toHaveBeenCalled();
  });

  it('proceeds with a resume carrying no input at all — a scheduled wake, a tool result landing', async () => {
    pausedAt(chatContract);
    await expect(resume({})).resolves.toEqual({ status: 'RUNNING' });
    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
    expect(scheduleStep).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    pausedAt(undefined);
    await expect(resume({})).resolves.toEqual({ status: 'RUNNING' });
    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
  });

  it('proceeds with a message, as text or keyed by the variable it maps to', async () => {
    for (const input of ['Ship it.', { input: 'Ship it.' }, { [CHAT_INPUT]: 'Ship it.' }]) {
      vi.clearAllMocks();
      pausedAt(chatContract);
      await expect(resume(input)).resolves.toEqual({ status: 'RUNNING' });
      const updates = mockAtomicCompleteStep.mock.calls[0]?.[3] as {
        runtimeState?: { variables: Record<string, { ref: { value: unknown } }> };
      };
      expect(updates.runtimeState?.variables[CHAT_INPUT]?.ref.value).toBe('Ship it.');
    }
  });

  it("proceeds where the input is the paused step's answer itself, which no variable maps", async () => {
    pausedAt(undefined, 'ask-1');
    await expect(resume({ decision: 'approved' })).resolves.toEqual({ status: 'RUNNING' });
    expect(mockAtomicCompleteStep).toHaveBeenCalledOnce();
  });
});
