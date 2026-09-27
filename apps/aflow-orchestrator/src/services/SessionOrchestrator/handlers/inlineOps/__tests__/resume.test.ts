import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockAddControlMessage = vi.fn();
const mockAddWaitingChild = vi.fn();
const mockAddStepResult = vi.fn();
const mockAbortDelegationLifecycle = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  addWaitingChild: (...args: unknown[]) => mockAddWaitingChild(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  abortDelegationLifecycle: (...args: unknown[]) => mockAbortDelegationLifecycle(...args),
}));

vi.mock('../../../helpers/delegationState.js', () => ({
  enterChildWait: vi.fn(),
}));

vi.mock('../../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

const TENANT = 'a0000000-0000-0000-0000-000000000001';
// UUIDs (not friendly labels) — `AgentResumeInputSchema.childSessionId` is
// `z.string().uuid()`, so the handler now rejects non-UUID test fixtures.
const HELMSMAN_RUN = '11111111-1111-4111-9111-111111111111';
const DRIVER_RUN = '22222222-2222-4222-9222-222222222222';
const NEW_STEP_EXEC = '33333333-3333-4333-9333-333333333333';

function makeArgs(
  overrides: {
    childSessionId?: string;
    message?: string;
    wait?: unknown;
    omitWait?: boolean;
  } = {},
): InlineHandlerArgs {
  const inputPayload: Record<string, unknown> = {
    childSessionId: overrides.childSessionId ?? DRIVER_RUN,
    message: overrides.message ?? 'continue',
  };
  if (!overrides.omitWait) {
    inputPayload['wait'] = 'wait' in overrides ? overrides.wait : 'until_pause';
  }
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(inputPayload),
    } as never,
    context: {
      tenantId: TENANT,
      runId: HELMSMAN_RUN,
      traceId: 'trace-1',
      actorContext: {},
      agentDefinition: { steps: [] },
      spaceId: 'space-1',
    } as never,
    stepDef: {
      stepId: 'resume',
      stepType: 'agent',
      operation: 'agent.control.resume',
      config: {},
      tags: [],
      role: 'helmsman-resume',
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: NEW_STEP_EXEC as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: 'inline:placeholder',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleResumeInline — parentStepExecutionId update on same-session resume', () => {
  it('updates the child parentStepExecutionId to the new resume step execution id (same-session)', async () => {
    // The user-observed bug: Helmsman previously delegated via
    // start-workflow (stepExecutionId=start-orig). The child paused;
    // until_pause bubbled SUCCEEDED back to Helmsman; Helmsman processed,
    // ran bind-capability, and now calls agent.control.resume on the
    // SAME child session. The resume step is a NEW execution
    // (stepExecutionId=resume-step-exec-1). The child's parentStepExecutionId
    // MUST be updated to this new id so the next bubble routes to the
    // correct paused step.
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: DRIVER_RUN,
      parentSessionId: HELMSMAN_RUN, // same session
      parentStepExecutionId: 'run-proc-orig', // OLD delegate step (already terminal)
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step-1',
    });

    const { handleResumeInline } = await import('../resume.js');
    await handleResumeInline(makeArgs());

    // Critical assertion: updateSessionState was called with parentStepExecutionId
    // pointing at the RESUME step, not the old delegate.
    expect(mockUpdateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      DRIVER_RUN,
      expect.objectContaining({
        parentStepExecutionId: NEW_STEP_EXEC,
      }),
    );
    // parentSessionId should NOT be updated when session is unchanged.
    const call = mockUpdateSessionState.mock.calls[0];
    expect(call?.[3]).not.toHaveProperty('parentSessionId');
  });

  it('updates BOTH parentStepExecutionId and parentSessionId on cross-session resume', async () => {
    // Cross-session resume: a new Executive session picking up a Driver
    // from a previous conversation. Both fields must update.
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: DRIVER_RUN,
      parentSessionId: 'old-helmsman-session', // DIFFERENT session
      parentStepExecutionId: 'old-step-exec',
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step-1',
    });

    const { handleResumeInline } = await import('../resume.js');
    await handleResumeInline(makeArgs());

    expect(mockUpdateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      DRIVER_RUN,
      expect.objectContaining({
        parentStepExecutionId: NEW_STEP_EXEC,
        parentSessionId: HELMSMAN_RUN,
      }),
    );
  });

  it('still emits PAUSED on the resume step (parent waits for child)', async () => {
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: DRIVER_RUN,
      parentSessionId: HELMSMAN_RUN,
      parentStepExecutionId: 'run-proc-orig',
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step-1',
    });

    const { handleResumeInline } = await import('../resume.js');
    await handleResumeInline(makeArgs());

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const call = mockAddStepResult.mock.calls[0]![1] as { status: string };
    expect(call.status).toBe('PAUSED');
  });
});

// ============================================================================
// Wait-mode resolution
//
// Live bug: Helmsman's LLM omitted `wait` (or passed `wait: true`) on
// `agent.control.resume`. Because the inline handler read raw input without
// applying the Zod schema's default, the parent's `delegationWaitMode` was
// never set to `'until_pause'`, so when the resumed Driver paused again the
// bubble fell through to the user-input pause path (Helmsman pause with no
// prompt content surfaced). The fix routes input through `AgentResumeInputSchema`
// so the default + the 'true'/'false' string preprocessor both fire.
// ============================================================================

describe('handleResumeInline — wait-mode resolution', () => {
  async function callWith(input: Parameters<typeof makeArgs>[0]) {
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: DRIVER_RUN,
      parentSessionId: HELMSMAN_RUN,
      parentStepExecutionId: 'run-proc-orig',
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step-1',
    });
    const { handleResumeInline } = await import('../resume.js');
    const { enterChildWait } = await import('../../../helpers/delegationState.js');
    await handleResumeInline(makeArgs(input));
    return enterChildWait as unknown as { mock: { calls: unknown[][] } };
  }

  it('defaults waitMode to until_pause when the LLM omits the wait field', async () => {
    const enterChildWait = await callWith({ omitWait: true });
    const lastCall = enterChildWait.mock.calls.at(-1) as unknown[];
    expect(lastCall?.[3]).toEqual({ waitMode: 'until_pause' });
  });

  it('passes through wait="until_pause"', async () => {
    const enterChildWait = await callWith({ wait: 'until_pause' });
    const lastCall = enterChildWait.mock.calls.at(-1) as unknown[];
    expect(lastCall?.[3]).toEqual({ waitMode: 'until_pause' });
  });

  it('maps wait=true (boolean) to waitMode="true"', async () => {
    const enterChildWait = await callWith({ wait: true });
    const lastCall = enterChildWait.mock.calls.at(-1) as unknown[];
    expect(lastCall?.[3]).toEqual({ waitMode: 'true' });
  });

  it('maps wait=false (boolean) to waitMode="false"', async () => {
    const enterChildWait = await callWith({ wait: false });
    const lastCall = enterChildWait.mock.calls.at(-1) as unknown[];
    expect(lastCall?.[3]).toEqual({ waitMode: 'false' });
  });

  it('maps wait="true" string to waitMode="true" via Zod preprocessor', async () => {
    const enterChildWait = await callWith({ wait: 'true' });
    const lastCall = enterChildWait.mock.calls.at(-1) as unknown[];
    expect(lastCall?.[3]).toEqual({ waitMode: 'true' });
  });

  it('emits FAILED step result when input fails schema validation', async () => {
    const { handleResumeInline } = await import('../resume.js');
    // childSessionId must be a uuid; a non-uuid trips the validator before
    // any session lookup runs.
    await handleResumeInline(makeArgs({ childSessionId: 'not-a-uuid' }));
    const call = mockAddStepResult.mock.calls.at(-1)?.[1] as { status: string };
    expect(call.status).toBe('FAILED');
  });
});

describe('handleResumeInline — Plan 131 lifecycle hygiene on resume', () => {
  it('aborts the prior delegation lifecycle BEFORE addWaitingChild rewrites the reverse index', async () => {
    // Without this, an existing pending entry from the prior child
    // PAUSE would carry the OLD parentStepExecutionId in its data hash,
    // and the drain (which prefers pending data over the reverse
    // index) could target the now-stale old delegate step. Aborting
    // here drops the resolved-by-bubble lifecycle; a new pending entry
    // is created when the resumed child reaches its next resting state.
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: DRIVER_RUN,
      parentSessionId: HELMSMAN_RUN,
      parentStepExecutionId: 'run-proc-orig',
      status: 'PAUSED',
      currentStepExecutionId: 'driver-step-1',
    });

    const { handleResumeInline } = await import('../resume.js');
    await handleResumeInline(makeArgs());

    // Must be called with the child session id.
    expect(mockAbortDelegationLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      DRIVER_RUN,
    );

    // Order matters: abort runs BEFORE addWaitingChild so the new
    // reverse index isn't immediately wiped by the abort.
    const abortOrder = mockAbortDelegationLifecycle.mock.invocationCallOrder[0];
    const addOrder = mockAddWaitingChild.mock.invocationCallOrder[0];
    expect(abortOrder).toBeDefined();
    expect(addOrder).toBeDefined();
    expect(abortOrder! < addOrder!).toBe(true);
  });
});
