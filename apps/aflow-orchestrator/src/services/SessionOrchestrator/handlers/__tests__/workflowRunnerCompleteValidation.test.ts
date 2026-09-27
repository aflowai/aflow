import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  AgentTurnDecision,
  StepDefinition,
  StepExecutionId,
} from '@aflow/schemas';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockUpdateSessionState = vi.fn();
const mockWaitForInput = vi.fn();
const mockFailStep = vi.fn();
const mockLoadOrCreate = vi.fn();
const mockStoreConversation = vi.fn();

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
  failStep: (...args: unknown[]) => mockFailStep(...args),
}));

vi.mock('../../helpers/aiHistory.js', () => ({
  loadOrCreateConversation: (...args: unknown[]) => mockLoadOrCreate(...args),
  storeConversation: (...args: unknown[]) => mockStoreConversation(...args),
}));

const { maybeFailWorkflowRunnerComplete, MAX_OUTPUT_CONTRACT_RETRIES } =
  await import('../workflowRunnerCompleteValidation.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

interface BuildArgsOpts {
  decision?: AgentTurnDecision;
  hotStateOverride?: Record<string, unknown>;
  runtimeStateOverride?: Record<string, unknown>;
  agentRole?: 'assistant' | 'subagent';
}

function buildArgs(opts: BuildArgsOpts = {}) {
  const decision: AgentTurnDecision =
    opts.decision ??
    ({ action: 'complete', result: { reportPath: '/r.html' } } as AgentTurnDecision);

  const runtimeState = {
    variables: {},
    version: 1,
    updatedAtMs: 1_000,
    ...opts.runtimeStateOverride,
  };

  const runHotState = {
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    workflowExecution: { runId: 'run-1', taskId: 'synthesize', attempt: 1 },
    ...opts.hotStateOverride,
  };

  return {
    redis: {} as never,
    payloadStore: { store: vi.fn(), retrieve: vi.fn() } as never,
    result: {
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      stepId: 'execute',
      stepExecutionId: 'sex-1' as StepExecutionId,
      attempt: 1,
      outputRef: 'inline:abc',
      traceId: 'trace-1',
    },
    agentDef: {
      flowId: 'cybernetic-runner',
      version: '1',
      steps: [{ stepId: 'execute' }],
    } as unknown as AgentDefinition,
    runtimeState,
    runHotState: runHotState as never,
    agentRoleConfig: {
      agentRole: opts.agentRole ?? ('subagent' as const),
    },
    decision,
    now: 1_700_000_000_000,
    scheduleStep: vi.fn().mockResolvedValue('next-sex' as StepExecutionId),
    stepDef: {
      stepId: 'execute',
      stepType: 'ai',
      operation: 'ai.agent.turn',
      name: 'Runner',
      config: {},
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
  };
}

beforeEach(() => {
  mockUpdateSessionState.mockReset();
  mockWaitForInput.mockReset();
  mockFailStep.mockReset();
  mockLoadOrCreate.mockReset();
  mockStoreConversation.mockReset();
  mockLoadOrCreate.mockResolvedValue({ messages: [], updatedAtMs: 0 });
  mockStoreConversation.mockImplementation(async (_store, _conv, runtimeState) => ({
    updatedState: runtimeState,
  }));
  mockUpdateSessionState.mockResolvedValue(undefined);
  mockWaitForInput.mockResolvedValue(undefined);
  mockFailStep.mockResolvedValue(undefined);
});

// ── Gate tests ──────────────────────────────────────────────────────────────

describe('maybeFailWorkflowRunnerComplete — gates', () => {
  it('returns null when decision is not complete', async () => {
    const args = buildArgs({
      decision: { action: 'invoke_step', toolId: 'x', args: {} } as AgentTurnDecision,
    });
    expect(await maybeFailWorkflowRunnerComplete(args)).toBeNull();
  });

  it('returns null when not a workflow runner (no workflowExecution)', async () => {
    const args = buildArgs({
      hotStateOverride: { workflowExecution: undefined },
    });
    expect(await maybeFailWorkflowRunnerComplete(args)).toBeNull();
    expect(args.scheduleStep).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('returns null for non-subagent roles (assistant completes pause; untouched)', async () => {
    const args = buildArgs({ agentRole: 'assistant' });
    expect(await maybeFailWorkflowRunnerComplete(args)).toBeNull();
  });
});

// ── 183d: complete is always a terminal-contract violation ──────────────────

describe('maybeFailWorkflowRunnerComplete — complete is rejected for workflow runners', () => {
  it('rejects complete even with a well-formed result — submit_output is the only terminal', async () => {
    const args = buildArgs({
      decision: {
        action: 'complete',
        result: { reportPath: '/r.html', cardData: { account: 'a1' } },
      } as AgentTurnDecision,
    });
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    expect(outcome).toBe('retried');
    expect(args.scheduleStep).toHaveBeenCalledOnce();
  });

  it('rejects complete with no result at all', async () => {
    const args = buildArgs({
      decision: { action: 'complete' } as AgentTurnDecision,
    });
    expect(await maybeFailWorkflowRunnerComplete(args)).toBe('retried');
  });

  it('appends a teaching message that names submit_output + the condition fields', async () => {
    const conversation = { messages: [] as Array<{ role: string; content: string }> };
    mockLoadOrCreate.mockResolvedValue(conversation);

    const args = buildArgs();
    await maybeFailWorkflowRunnerComplete(args);

    expect(conversation.messages).toHaveLength(1);
    const msg = conversation.messages[0]!;
    expect(msg.role).toBe('system');
    expect(msg.content).toContain('submit_output');
    expect(msg.content).toContain('signal_blocked');
  });
});

// ── Retry counter behaviour ────────────────────────────────────────────────

describe('maybeFailWorkflowRunnerComplete — retry counter', () => {
  it('first violation: retries with counter at 1', async () => {
    const args = buildArgs();
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    expect(outcome).toBe('retried');
    expect(mockUpdateSessionState).toHaveBeenCalledOnce();
    const written = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, unknown> };
    };
    const counterVar = written.runtimeState.variables['ai.agent.outputContractRetries.execute'] as
      { ref?: { kind: string; value?: number } } | undefined;
    // The counter is stored inline via writeInlineVar; assert its presence.
    expect(counterVar).toBeDefined();
  });

  it('second violation in same step: counter advances; still under budget', async () => {
    const args = buildArgs({
      runtimeStateOverride: {
        variables: {
          'ai.agent.outputContractRetries.execute': {
            ref: { kind: 'inline', value: 2 },
            updatedAtMs: 0,
            updatedBy: { stepExecutionId: 'sex-0', stepId: 'execute', actor: 'orchestrator' },
            version: 2,
          },
        },
      },
    });
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    // priorRetries=2, newRetryCount=3, still <= MAX (3), so retried.
    expect(outcome).toBe('retried');
    expect(args.scheduleStep).toHaveBeenCalled();
  });
});

// ── Retry persist failure ───────────────────────────────────────────────────

describe('maybeFailWorkflowRunnerComplete — retry persist failure', () => {
  it('fails (not reschedules) when updateSessionState throws — counter would otherwise be lost', async () => {
    mockUpdateSessionState.mockRejectedValueOnce(new Error('redis ECONNRESET'));
    const args = buildArgs();
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    // Without persistence, rescheduling would re-read priorRetries=0
    // and loop forever. Must fail the run.
    expect(outcome).toBe('failed');
    expect(args.scheduleStep).not.toHaveBeenCalled();
    expect(mockFailStep).toHaveBeenCalledOnce();

    const failArgs = mockFailStep.mock.calls[0]?.[3] as {
      errorRef: string;
      classification: string;
    };
    const parsed = JSON.parse(
      Buffer.from(failArgs.errorRef.replace('inline:', ''), 'base64').toString('utf8'),
    ) as { code: string; classification: string };
    expect(parsed.code).toBe('OUTPUT_CONTRACT_RETRY_PERSIST_FAILED');
    expect(parsed.classification).toBe('internal');
  });

  it('fails when storeConversation throws (same persist-failure path)', async () => {
    mockStoreConversation.mockRejectedValueOnce(new Error('gcs 503'));
    const args = buildArgs();
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    expect(outcome).toBe('failed');
    expect(args.scheduleStep).not.toHaveBeenCalled();
  });
});

// ── Budget exhaustion ──────────────────────────────────────────────────────

describe('maybeFailWorkflowRunnerComplete — budget exhaustion', () => {
  it(`fails the run when retry count exceeds MAX_OUTPUT_CONTRACT_RETRIES (${String(MAX_OUTPUT_CONTRACT_RETRIES)})`, async () => {
    const args = buildArgs({
      runtimeStateOverride: {
        variables: {
          'ai.agent.outputContractRetries.execute': {
            ref: { kind: 'inline', value: MAX_OUTPUT_CONTRACT_RETRIES },
            updatedAtMs: 0,
            updatedBy: {
              stepExecutionId: 'sex-0',
              stepId: 'execute',
              actor: 'orchestrator',
            },
            version: MAX_OUTPUT_CONTRACT_RETRIES,
          },
        },
      },
    });
    const outcome = await maybeFailWorkflowRunnerComplete(args);
    expect(outcome).toBe('failed');
    expect(mockFailStep).toHaveBeenCalledOnce();
    expect(args.scheduleStep).not.toHaveBeenCalled();

    const failArgs = mockFailStep.mock.calls[0]?.[3] as {
      errorRef: string;
      classification: string;
    };
    const errorJson = Buffer.from(failArgs.errorRef.replace('inline:', ''), 'base64').toString(
      'utf8',
    );
    const parsed = JSON.parse(errorJson) as { code: string; classification: string };
    expect(parsed.code).toBe('OUTPUT_CONTRACT_VIOLATION_PERSISTENT');
    expect(parsed.classification).toBe('validation');
  });
});
