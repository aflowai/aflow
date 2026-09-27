import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, StepDefinition, StepExecutionId } from '@aflow/schemas';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockUpdateSessionState = vi.fn();
const mockWaitForInput = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  };
});

vi.mock('../../../StepService/index.js', () => ({
  waitForInput: (...args: unknown[]) => mockWaitForInput(...args),
  completeStep: vi.fn(),
  failStep: vi.fn(),
}));

const mockRoutePause = vi.fn().mockResolvedValue('not_autonomous');
vi.mock('../pausedSessionRouting.js', () => ({
  routeSessionPauseToSubscribers: (...args: unknown[]) => mockRoutePause(...args),
}));

const {
  recoverInvalidAgentDecision,
  recoverFailedAgentDecision,
  isAgentDecisionInvalidFailure,
  MAX_INVALID_DECISION_RETRIES,
} = await import('../agentDecisionRecovery.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const STEP_ID = 'agent';
const STEP_EXEC_ID = 'sex-1' as StepExecutionId;
const AJV_MESSAGE =
  'Agent tool "start-workflow" arguments invalid: : must have required property \'slug\'';

function makeStepDef(config: Record<string, unknown>): StepDefinition {
  return {
    stepId: STEP_ID,
    stepType: 'ai',
    operation: 'ai.agent.turn',
    name: 'Agent',
    config,
    tags: [],
    optional: false,
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;
}

const ASSISTANT_CONFIG = {
  agentRole: 'assistant',
  requestInputPolicy: 'allowed',
  completionPolicy: 'open_ended',
};
const SUBAGENT_CONFIG = {
  agentRole: 'subagent',
  requestInputPolicy: 'never',
  completionPolicy: 'open_ended',
};

function counterVar(value: number) {
  return {
    ref: { kind: 'inline' as const, value },
    updatedAtMs: NOW,
    updatedBy: { actor: 'orchestrator', stepId: STEP_ID, stepExecutionId: STEP_EXEC_ID },
    version: value,
  };
}

interface BuildOpts {
  config?: Record<string, unknown>;
  priorRetries?: number;
  message?: string;
  details?: unknown;
}

function buildArgs(opts: BuildOpts = {}) {
  const variables: Record<string, unknown> = {};
  if (opts.priorRetries !== undefined) {
    variables[`ai.agent.invalidDecisionRetries.${STEP_ID}`] = counterVar(opts.priorRetries);
  }
  return {
    redis: {} as never,
    payloadStore: { store: vi.fn(), retrieve: vi.fn() } as never,
    result: {
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      stepId: STEP_ID,
      stepExecutionId: STEP_EXEC_ID as string,
      attempt: 1,
      traceId: 'trace-1',
    },
    error: {
      message: opts.message ?? AJV_MESSAGE,
      details: opts.details ?? { reason: AJV_MESSAGE, toolName: 'start-workflow' },
    },
    inputRef: 'inline:original-input',
    agentDef: {
      flowId: 'cybernetic-helmsman',
      version: '1',
      steps: [{ stepId: STEP_ID }],
    } as unknown as AgentDefinition,
    stepDef: makeStepDef(opts.config ?? ASSISTANT_CONFIG),
    currentRuntimeState: { schemaVersion: 1 as const, variables, version: 1, updatedAtMs: NOW },
    scheduleStep: vi.fn().mockResolvedValue('sex-next' as StepExecutionId),
    now: NOW,
  };
}

beforeEach(() => {
  mockUpdateSessionState.mockReset().mockResolvedValue(undefined);
  mockRoutePause.mockClear();
  mockWaitForInput.mockReset().mockResolvedValue({
    kind: 'paused',
    requestedInputRef: 'inline:cGF1c2U=',
  });
});

// ── isAgentDecisionInvalidFailure ──────────────────────────────────────────

describe('isAgentDecisionInvalidFailure', () => {
  it('matches the AGENT_DECISION_INVALID code', () => {
    expect(isAgentDecisionInvalidFailure({ code: 'AGENT_DECISION_INVALID' })).toBe(true);
  });
  it('does not match a plain validation error or null', () => {
    expect(isAgentDecisionInvalidFailure({ code: 'VALIDATION_ERROR' })).toBe(false);
    expect(isAgentDecisionInvalidFailure(null)).toBe(false);
    expect(isAgentDecisionInvalidFailure(undefined)).toBe(false);
  });
});

// ── Bounded guided retry ────────────────────────────────────────────────────

describe('recoverInvalidAgentDecision — guided retry', () => {
  it('reschedules the same turn with the specific Ajv error as guidance and counter=1', async () => {
    const args = buildArgs();
    const outcome = await recoverInvalidAgentDecision(args);

    expect(outcome).toBe('retried');
    expect(mockWaitForInput).not.toHaveBeenCalled();

    // Same turn re-run verbatim (same stepId + original inputRef).
    expect(args.scheduleStep).toHaveBeenCalledOnce();
    const scheduled = args.scheduleStep.mock.calls[0]?.[0] as { stepId: string; inputRef: string };
    expect(scheduled.stepId).toBe(STEP_ID);
    expect(scheduled.inputRef).toBe('inline:original-input');

    // Persisted BEFORE the reschedule: the guidance carries the exact field
    // violation + the tool name (not a generic string), and the counter is 1.
    expect(mockUpdateSessionState).toHaveBeenCalledOnce();
    const patch = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, { ref?: { value?: unknown } }> };
    };
    const guidance = patch.runtimeState.variables[`ai.agent.chatInput.${STEP_ID}`]?.ref?.value;
    expect(guidance).toContain("must have required property 'slug'");
    expect(guidance).toContain('start-workflow');
    expect(
      patch.runtimeState.variables[`ai.agent.invalidDecisionRetries.${STEP_ID}`]?.ref?.value,
    ).toBe(1);
  });

  it('a fresh budget (no prior counter) retries at 1 — no retry debt carried forward', async () => {
    const args = buildArgs({ priorRetries: undefined });
    expect(await recoverInvalidAgentDecision(args)).toBe('retried');
    const patch = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, { ref?: { value?: unknown } }> };
    };
    expect(
      patch.runtimeState.variables[`ai.agent.invalidDecisionRetries.${STEP_ID}`]?.ref?.value,
    ).toBe(1);
  });

  it('advances the counter on a subsequent invalid decision while under the cap', async () => {
    const args = buildArgs({ priorRetries: MAX_INVALID_DECISION_RETRIES - 1 });
    expect(await recoverInvalidAgentDecision(args)).toBe('retried');
    expect(args.scheduleStep).toHaveBeenCalledOnce();
    const patch = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, { ref?: { value?: unknown } }> };
    };
    expect(
      patch.runtimeState.variables[`ai.agent.invalidDecisionRetries.${STEP_ID}`]?.ref?.value,
    ).toBe(MAX_INVALID_DECISION_RETRIES);
  });
});

// ── Terminal pause (interactive) ────────────────────────────────────────────

describe('recoverInvalidAgentDecision — operator pause at the cap', () => {
  it(`pauses (never re-dispatches) after ${String(MAX_INVALID_DECISION_RETRIES)} invalid decisions`, async () => {
    const args = buildArgs({ priorRetries: MAX_INVALID_DECISION_RETRIES });
    const outcome = await recoverInvalidAgentDecision(args);

    expect(outcome).toBe('paused');
    // The loop is bounded by construction: the terminal state is a pause that
    // waits for a human message; the turn is NOT rescheduled.
    expect(args.scheduleStep).not.toHaveBeenCalled();
    expect(mockWaitForInput).toHaveBeenCalledOnce();

    const opts = mockWaitForInput.mock.calls[0]?.[3] as {
      prompt: string;
      pauseType: string;
      runtimeState: { variables: Record<string, unknown> };
    };
    expect(opts.pauseType).toBe('invalid_decision');
    // The pause names the tool, the validation error, and the attempt count.
    expect(opts.prompt).toContain('start-workflow');
    expect(opts.prompt).toContain("must have required property 'slug'");
    expect(opts.prompt).toContain(String(MAX_INVALID_DECISION_RETRIES));
    // The counter is cleared so an operator-driven retry gets a fresh budget.
    expect(
      opts.runtimeState.variables[`ai.agent.invalidDecisionRetries.${STEP_ID}`],
    ).toBeUndefined();

    // The pause is routed onward with its contract — an autonomous session's
    // subscriber must learn about it, or the pause strands the parent.
    expect(mockRoutePause).toHaveBeenCalledOnce();
    const [, routeArgs] = mockRoutePause.mock.calls[0] as [
      unknown,
      { contractRef: string | null; pauseReason: string },
    ];
    expect(routeArgs.contractRef).toBe('inline:cGF1c2U=');
    expect(routeArgs.pauseReason).toContain('start-workflow');
  });

  it('falls back to a generic tool label when no tool name is carried', async () => {
    const args = buildArgs({
      priorRetries: MAX_INVALID_DECISION_RETRIES,
      details: { reason: 'malformed' },
    });
    expect(await recoverInvalidAgentDecision(args)).toBe('paused');
    const opts = mockWaitForInput.mock.calls[0]?.[3] as { prompt: string };
    expect(opts.prompt).toContain('the requested tool');
  });
});

// ── Non-interactive agents are untouched ────────────────────────────────────

describe('recoverInvalidAgentDecision — non-interactive agents', () => {
  it('returns not_interactive for a subagent (Runner/Coach) — existing failure routing preserved', async () => {
    const args = buildArgs({ config: SUBAGENT_CONFIG, priorRetries: MAX_INVALID_DECISION_RETRIES });
    const outcome = await recoverInvalidAgentDecision(args);

    expect(outcome).toBe('not_interactive');
    expect(args.scheduleStep).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('returns not_interactive for an assistant explicitly barred from input (requestInputPolicy: never)', async () => {
    const args = buildArgs({
      config: {
        agentRole: 'assistant',
        requestInputPolicy: 'never',
        completionPolicy: 'open_ended',
      },
    });
    expect(await recoverInvalidAgentDecision(args)).toBe('not_interactive');
    expect(args.scheduleStep).not.toHaveBeenCalled();
  });
});

// ── recoverFailedAgentDecision — applyResult FAILED-path entry ──────────────

describe('recoverFailedAgentDecision — signal + role gating', () => {
  function wrapperArgs(opts: {
    operation?: string;
    errorCode?: string;
    config?: Record<string, unknown>;
  }) {
    return {
      redis: {} as never,
      payloadStore: { store: vi.fn(), retrieve: vi.fn() } as never,
      result: {
        tenantId: 'tenant-1',
        sessionId: 'sess-1',
        stepId: STEP_ID,
        stepExecutionId: STEP_EXEC_ID as string,
        attempt: 1,
        traceId: 'trace-1',
        error: { code: opts.errorCode ?? 'AGENT_DECISION_INVALID', message: AJV_MESSAGE },
      },
      stepDef: {
        ...makeStepDef(opts.config ?? ASSISTANT_CONFIG),
        operation: opts.operation ?? 'ai.agent.turn',
      } as unknown as StepDefinition,
      agentDef: {
        flowId: 'x',
        version: '1',
        steps: [{ stepId: STEP_ID }],
      } as unknown as AgentDefinition,
      runState: {
        runtimeState: { schemaVersion: 1 as const, variables: {}, version: 1, updatedAtMs: NOW },
      } as never,
      stepState: { inputRef: 'inline:original-input' } as never,
      scheduleStep: vi.fn().mockResolvedValue('sex-next' as StepExecutionId),
      now: NOW,
    };
  }

  it('returns false for a non-agent-turn operation (falls through to normal failure)', async () => {
    const args = wrapperArgs({ operation: 'memory.store.get' });
    expect(await recoverFailedAgentDecision(args)).toBe(false);
    expect(args.scheduleStep).not.toHaveBeenCalled();
  });

  it('returns false when the failure is not the invalid-decision signal', async () => {
    const args = wrapperArgs({ errorCode: 'PROVIDER_ERROR' });
    expect(await recoverFailedAgentDecision(args)).toBe(false);
  });

  it('handles (true) an interactive invalid-decision failure', async () => {
    const args = wrapperArgs({});
    expect(await recoverFailedAgentDecision(args)).toBe(true);
    expect(args.scheduleStep).toHaveBeenCalledOnce();
  });

  it('returns false (not handled) for a subagent invalid-decision failure', async () => {
    const args = wrapperArgs({ config: SUBAGENT_CONFIG });
    expect(await recoverFailedAgentDecision(args)).toBe(false);
    expect(args.scheduleStep).not.toHaveBeenCalled();
  });
});
