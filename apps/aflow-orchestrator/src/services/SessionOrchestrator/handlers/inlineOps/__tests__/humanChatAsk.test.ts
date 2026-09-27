import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  IdempotencyKey,
  StepDefinition,
  StepExecutionId,
} from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockGetSessionState = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...(args as [])),
}));

import { HITL_INLINE_PLACEMENT_TAG, handleHumanChatAskInline } from '../humanChatAsk.js';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeInline(ref: string): unknown {
  const b64 = ref.replace(/^inline:/, '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

function makeAskStepDef(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    stepId: 'helmsman-ask-step',
    stepType: 'human',
    operation: 'human.chat.ask',
    name: 'Ask the user',
    config: {},
    tags: ['dynamic', 'virtual_tool', '_toolId:human.chat.ask'],
    optional: false,
    outputOptions: { displayToUser: true },
    onSuccess: { next: [{ stepId: 'helmsman-agent', priority: 50 }] },
    onFailure: { next: [{ stepId: 'helmsman-agent', priority: 50 }] },
    ...overrides,
  } as StepDefinition;
}

function makeAgentDef(steps: StepDefinition[]): AgentDefinition {
  return {
    agentId: 'helmsman',
    version: 'v1',
    name: 'Helmsman',
    description: '',
    startStepId: 'helmsman-agent' as StepDefinition['stepId'],
    steps,
    metadata: {},
  } as unknown as AgentDefinition;
}

function makeCtx(agentDef: AgentDefinition) {
  return {
    tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
    runId: 'session-1' as never,
    traceId: 'trace-1' as never,
    spaceId: '00000000-0000-0000-0000-000000000aaa',
    agentDefinition: agentDef,
  };
}

const mockPayloadStore = {
  retrieve: vi.fn(),
  shouldStore: () => false,
} as unknown as Parameters<typeof handleHumanChatAskInline>[1];

const mockRedis = {} as Parameters<typeof handleHumanChatAskInline>[0];

beforeEach(() => {
  mockAddStepResult.mockReset();
  mockUpdateSessionState.mockReset();
  mockGetSessionState.mockReset();
  mockGetSessionState.mockReturnValue(Promise.resolve(undefined));
  (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockReset();
});

describe('handleHumanChatAskInline — Plan 156 §5.6.1', () => {
  it('input-kind: injects a user.interaction.ask child with all routing tags', async () => {
    const askStepDef = makeAskStepDef();
    const agentDef = makeAgentDef([askStepDef]);
    const ctx = makeCtx(agentDef);

    const askInput = {
      kind: 'input',
      prompt: 'Which dataset?',
      inputSchema: { type: 'string', enum: ['sales', 'returns'] },
      uiHints: { mode: 'choices', submitLabel: 'Use this' },
    };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(askInput);

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-1' as StepExecutionId,
      'idem-1' as IdempotencyKey,
      inlineRef(askInput),
      0,
      Date.now(),
    );

    expect(agentDef.steps).toHaveLength(2);
    const child = agentDef.steps[1]!;
    expect(child.operation).toBe('user.interaction.ask');
    expect(child.stepType).toBe('user');
    expect(child.tags).toContain('dynamic');
    expect(child.tags).toContain(HITL_INLINE_PLACEMENT_TAG);
    expect(child.tags).toContain('_routing:exec-1');
    expect(child.tags).toContain(`parent:${askStepDef.stepId}`);
    expect(child.tags).toContain('_toolId:human.chat.ask');
    expect(child.onSuccess).toEqual(askStepDef.onSuccess);
    expect(child.onFailure).toEqual(askStepDef.onFailure);
  });

  it('approval-kind: injects a user.interaction.approve child', async () => {
    const askStepDef = makeAskStepDef();
    const agentDef = makeAgentDef([askStepDef]);
    const ctx = makeCtx(agentDef);

    const askInput = {
      kind: 'approval',
      title: 'Deploy?',
      description: 'Promote v2.3.0.',
      reviewData: { rows: 432 },
    };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(askInput);

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-2' as StepExecutionId,
      'idem-2' as IdempotencyKey,
      inlineRef(askInput),
      0,
      Date.now(),
    );

    const child = agentDef.steps[1]!;
    expect(child.operation).toBe('user.interaction.approve');
    expect(child.tags).toContain('_routing:exec-2');
  });

  it('propagates outputMapping to the child (Phase 5b review P2)', async () => {
    const askStepDef = makeAskStepDef({
      outputMapping: { datasetChoice: '${output.input}' } as never,
    });
    const agentDef = makeAgentDef([askStepDef]);
    const ctx = makeCtx(agentDef);

    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'input',
      prompt: 'Pick one',
    });

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-3' as StepExecutionId,
      'idem-3' as IdempotencyKey,
      inlineRef({ kind: 'input', prompt: 'Pick one' }),
      0,
      Date.now(),
    );

    const child = agentDef.steps[1]!;
    expect(child.outputMapping).toEqual({ datasetChoice: '${output.input}' });
  });

  it('emits SUCCESS with the child user.interaction payload as outputRef', async () => {
    const askStepDef = makeAskStepDef();
    const ctx = makeCtx(makeAgentDef([askStepDef]));
    const askInput = {
      kind: 'input' as const,
      prompt: 'What city?',
      uiHints: { submitLabel: 'OK' },
    };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(askInput);

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-4' as StepExecutionId,
      'idem-4' as IdempotencyKey,
      inlineRef(askInput),
      0,
      Date.now(),
    );

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      outputRef: string;
      operationId: string;
    };
    expect(result.status).toBe('SUCCEEDED');
    expect(result.operationId).toBe('human.chat.ask');
    const decoded = decodeInline(result.outputRef) as Record<string, unknown>;
    // The outputRef carries the child's *input* (so the routed
    // scheduleStep feeds it as inputRef), NOT a HumanChatAskOutput.
    expect(decoded.prompt).toBe('What city?');
    expect(decoded.uiHints).toEqual({ submitLabel: 'OK' });
  });

  it('persists the child to Redis dynamicSteps so routing survives restarts', async () => {
    const askStepDef = makeAskStepDef();
    const ctx = makeCtx(makeAgentDef([askStepDef]));
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'input',
      prompt: '?',
    });
    mockGetSessionState.mockReturnValue(Promise.resolve(undefined));

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-5' as StepExecutionId,
      'idem-5' as IdempotencyKey,
      inlineRef({ kind: 'input', prompt: '?' }),
      0,
      Date.now(),
    );

    expect(mockUpdateSessionState).toHaveBeenCalledTimes(1);
    const [, , , patch] = mockUpdateSessionState.mock.calls[0]!;
    expect(typeof (patch as Record<string, unknown>).dynamicSteps).toBe('string');
    const persisted = JSON.parse(
      (patch as { dynamicSteps: string }).dynamicSteps,
    ) as StepDefinition[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.operation).toBe('user.interaction.ask');
    expect(persisted[0]!.tags).toContain('_routing:exec-5');
  });

  it('emits FAILED (not throw) when input fails schema validation', async () => {
    const askStepDef = makeAskStepDef();
    const ctx = makeCtx(makeAgentDef([askStepDef]));
    // kind="input" without prompt — discriminator rejects.
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: 'input',
    });

    await handleHumanChatAskInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      askStepDef,
      'exec-6' as StepExecutionId,
      'idem-6' as IdempotencyKey,
      inlineRef({ kind: 'input' }),
      0,
      Date.now(),
    );

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { code: string; message: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('HUMAN_CHAT_ASK_FAILED');
    expect(result.error.message).toMatch(/prompt.*required/i);
  });
});
