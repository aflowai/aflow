import { describe, it, expect, vi, beforeEach } from 'vitest';
import Ajv from 'ajv';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { validationError } from '@aflow/executor-runtime';
import { BLOCKED_REASON_AUTO_CONVERT_PREFIX, createValidationError } from '@aflow/schemas';
import type {
  AiConversationStateV1,
  PayloadRef,
  TenantId,
  SessionId,
  StepExecutionId,
} from '@aflow/schemas';
import type { AgentTurnInput } from '../schema.js';
import type { HandlerDeps } from './types.js';
import { handleAgentTurn, fallbackPressureTokens } from './agentTurn.js';
import {
  validateAgentDecisionForPersistence,
  parseGenerateJsonAgentDecision,
  InvalidAgentTurnDecisionError,
  mergeCostBreakdown,
} from './agentTurnDecision.js';
import { convertOrphanToolMessages } from './agentNativeFunctionCalling.js';
import { ConversationHistoryHydrationError } from '../../historyHydrationError.js';
import { prepareAgentRequest } from './agentTurnRequest.js';
import { getAIClientForContext } from '../aiClient.js';

vi.mock('../aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

const tenantId = 'tenant-test';
const runId = 'run-test';
const stepExecutionId = 'step-exec-test';
const turnNumber = 3;
const model = 'test-model';
const provider = 'openai';

describe('fallbackPressureTokens — clearing pressure excludes the tool surface (Plan 259)', () => {
  it('sums system+context+history and never the tools component', () => {
    const breakdown = { system: 1000, context: 500, history: 2000, tools: 8000, total: 11500 };
    // Tools are re-emitted every turn and can't be relieved by clearing, so the
    // pressure that triggers clearing/compaction must exclude them — otherwise a
    // large tool surface would force history clearing that frees nothing.
    expect(fallbackPressureTokens(breakdown)).toBe(3500);
    expect(fallbackPressureTokens(breakdown)).not.toBe(breakdown.total);
  });

  it('returns 0 when no breakdown is available', () => {
    expect(fallbackPressureTokens(undefined)).toBe(0);
  });
});

function baseAgentInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'Do the thing',
    availableTools: [
      {
        toolId: 'step-a',
        operationId: 'op.a',
        stepType: 'api',
        name: 'Step A',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ],
    policy: {
      maxToolCallsPerTurn: 5,
      allowParallel: true,
      maxParallel: 2,
      allowComplete: true,
    },
    turnNumber,
    model,
    ...overrides,
  };
}

function makeCtx(): ExecutorContext {
  return {
    job: {
      tenantId,
      runId,
      stepId: 'agent-1',
      stepExecutionId,
      attempt: 1,
    },
    log: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    emitRunEvent: vi.fn().mockResolvedValue(undefined),
    emitLiveDelta: vi.fn().mockResolvedValue(undefined),
    writePayload: vi.fn().mockResolvedValue('inline:test'),
  } as unknown as ExecutorContext;
}

const signalBlockedToolSpec = {
  toolId: 'signal_blocked',
  operationId: 'agent.control.signal_blocked',
  stepType: 'agent',
  name: 'Signal Blocked',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      category: { type: 'string', enum: ['missing_input', 'external_dependency', 'other'] },
    },
    required: ['reason', 'category'],
  },
};

function neverPolicyInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return baseAgentInput({
    requestInputPolicy: 'never',
    policy: {
      maxToolCallsPerTurn: 5,
      allowParallel: true,
      maxParallel: 2,
      allowComplete: false,
    },
    ...overrides,
  });
}

describe('validateAgentDecisionForPersistence', () => {
  const ajvLocal = new Ajv();
  const deps: HandlerDeps = {
    payloadStore: createMemoryPayloadStore(),
    handleError: vi.fn(),
    validateToolArgs: (stepId, args, inputSchema) => {
      if (Object.keys(inputSchema).length === 0) return null;
      const validate = ajvLocal.compile(inputSchema);
      if (validate(args)) return null;
      const msg = (validate.errors ?? [])
        .map((e) => `${e.keyword ?? 'error'} ${e.instancePath ?? '/'}: ${e.message ?? ''}`)
        .join('; ');
      return validationError(`Agent tool "${stepId}" arguments invalid: ${msg}`);
    },
  };

  it('flags non-object args as repairable_reject', () => {
    const params = baseAgentInput();
    const r = validateAgentDecisionForPersistence(params, deps, {
      action: 'invoke_step',
      toolId: 'step-a',
      args: 'not-an-object' as unknown as Record<string, unknown>,
    });
    expect(r.kind).toBe('repairable_reject');
    if (r.kind === 'repairable_reject') {
      expect(r.reason).toMatch(/JSON object/i);
      expect(r.code).toBe('args_not_object');
    }
  });

  it('flags missing required tool arg as repairable_reject (AJV)', () => {
    const params = baseAgentInput();
    const r = validateAgentDecisionForPersistence(params, deps, {
      action: 'invoke_step',
      toolId: 'step-a',
      args: {},
    });
    expect(r.kind).toBe('repairable_reject');
    if (r.kind === 'repairable_reject') {
      expect(r.code).toBe('tool_args_invalid');
    }
  });

  it('clamps invoke_steps over maxParallel to the cap instead of failing the run', () => {
    const params = baseAgentInput({
      policy: {
        maxToolCallsPerTurn: 5,
        allowParallel: true,
        maxParallel: 1,
        allowComplete: true,
      },
    });
    const r = validateAgentDecisionForPersistence(params, deps, {
      action: 'invoke_steps',
      calls: [
        { toolId: 'step-a', args: { q: '1' } },
        { toolId: 'step-a', args: { q: '2' } },
      ],
    });
    // Over-parallel degrades gracefully: the first `cap` independent calls run this
    // turn (the agent re-requests the rest next turn) — it is NOT a run-failing reject.
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted' && r.decision.action === 'invoke_steps') {
      expect(r.decision.calls).toHaveLength(1);
      expect(r.decision.calls[0]!.args).toEqual({ q: '1' });
    }
  });

  it('maps schema compile failures to repairable_reject with schema_compile_failed', () => {
    const compileDeps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: () =>
        createValidationError('could not compile', [
          { path: [], code: 'schema_compile_failed', message: 'bad schema' },
        ]),
    };
    const params = baseAgentInput();
    const r = validateAgentDecisionForPersistence(params, compileDeps, {
      action: 'invoke_step',
      toolId: 'step-a',
      args: { q: 'x' },
    });
    expect(r.kind).toBe('repairable_reject');
    if (r.kind === 'repairable_reject') {
      expect(r.code).toBe('schema_compile_failed');
    }
  });

  it('names the blocked-signal tool in the pause repair hint by its actual toolId', () => {
    const params = neverPolicyInput({
      availableTools: [
        ...baseAgentInput().availableTools,
        { ...signalBlockedToolSpec, toolId: 'escalate' },
      ],
    });
    const r = validateAgentDecisionForPersistence(params, deps, {
      action: 'pause_for_input',
      message: 'Which dataset should I use?',
    });
    expect(r.kind).toBe('repairable_reject');
    if (r.kind === 'repairable_reject') {
      expect(r.reason).toContain('**escalate**');
      expect(r.reason).not.toContain('**signal_blocked**');
    }
  });
});

describe('parseGenerateJsonAgentDecision', () => {
  let generateJsonCalls = 0;

  beforeEach(() => {
    generateJsonCalls = 0;
  });

  it('performs exactly one repair generateJson when the first raw decision fails Zod', async () => {
    const ctx = makeCtx();
    const params = baseAgentInput();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: () => null,
    };
    const client = {
      generateJson: vi.fn().mockImplementation(() => {
        generateJsonCalls += 1;
        return Promise.resolve({
          data: { action: 'pause_for_input', message: 'fixed' },
          rawContent: '{"action":"pause_for_input","message":"fixed"}',
          model: 'repair-model-id',
          provider: 'anthropic',
          usage: { promptTokens: 2, completionTokens: 8, totalTokens: 10 },
          cost: { promptCost: 0.1, completionCost: 0.4, totalCost: 0.5, currency: 'USD' },
        });
      }),
    };

    const out = await parseGenerateJsonAgentDecision(
      ctx,
      deps,
      client as never,
      model,
      [],
      params,
      {
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        model: 'first-model-id',
        provider: 'openai',
        cost: { promptCost: 1, completionCost: 2, totalCost: 3, currency: 'USD' },
      },
      { action: 'not_valid' } as Record<string, unknown>,
      '{"action":"not_valid"}',
    );
    expect(generateJsonCalls).toBe(1);
    expect(out.decision.action).toBe('pause_for_input');
    expect(out.rawContent).toBe('{"action":"pause_for_input","message":"fixed"}');
    expect(out.requestSnapshot).toBeDefined();
    expect(out.attemptNotes).toContain('generate_json_zod_repair_succeeded');
    expect(out.usage).toEqual({
      promptTokens: 102,
      completionTokens: 28,
      totalTokens: 130,
    });
    expect(out.model).toBe('repair-model-id');
    expect(out.provider).toBe('anthropic');
    expect(out.cost).toEqual({
      promptCost: 1.1,
      completionCost: 2.4,
      totalCost: 3.5,
      currency: 'USD',
    });
  });

  it('without Zod repair returns first generateJson usage, model, and provider', async () => {
    const ctx = makeCtx();
    const params = baseAgentInput();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: () => null,
    };
    const client = { generateJson: vi.fn() };

    const out = await parseGenerateJsonAgentDecision(
      ctx,
      deps,
      client as never,
      model,
      [],
      params,
      {
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        model: 'only-model',
        provider: 'google',
        cost: { promptCost: 0.01, completionCost: 0.02, totalCost: 0.03, currency: 'USD' },
      },
      { action: 'pause_for_input', message: 'ok' } as Record<string, unknown>,
      '{"action":"pause_for_input","message":"ok"}',
    );

    expect(client.generateJson).not.toHaveBeenCalled();
    expect(out.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(out.model).toBe('only-model');
    expect(out.provider).toBe('google');
    expect(out.cost).toEqual({
      promptCost: 0.01,
      completionCost: 0.02,
      totalCost: 0.03,
      currency: 'USD',
    });
  });

  it('coerces a text-only reply into the blocked-signal call under never policy without completion', async () => {
    const ctx = makeCtx();
    const params = neverPolicyInput({
      availableTools: [...baseAgentInput().availableTools, signalBlockedToolSpec],
    });
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: () => null,
    };
    const client = { generateJson: vi.fn() };

    const out = await parseGenerateJsonAgentDecision(
      ctx,
      deps,
      client as never,
      model,
      [],
      params,
      {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model,
        provider,
      },
      { action: null, message: 'I cannot find the dataset.' } as Record<string, unknown>,
      'I cannot find the dataset.',
    );

    expect(client.generateJson).not.toHaveBeenCalled();
    expect(out.decision).toMatchObject({
      action: 'invoke_step',
      toolId: 'signal_blocked',
      args: {
        reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}I cannot find the dataset.`,
        category: 'missing_input',
      },
    });
  });

  it('coerces an explicit pause_for_input into the blocked-signal call under never policy without completion', async () => {
    const ctx = makeCtx();
    const params = neverPolicyInput({
      availableTools: [...baseAgentInput().availableTools, signalBlockedToolSpec],
    });
    const ajvDeps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: (stepId, args, inputSchema) => {
        const validate = new Ajv().compile(inputSchema);
        if (validate(args)) return null;
        return validationError('invalid args');
      },
    };
    const client = { generateJson: vi.fn() };

    const out = await parseGenerateJsonAgentDecision(
      ctx,
      ajvDeps,
      client as never,
      model,
      [],
      params,
      {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model,
        provider,
      },
      {
        action: 'pause_for_input',
        message: 'Which API should I bind?',
        reasoning: 'Ambiguous binding',
      } as Record<string, unknown>,
      '{"action":"pause_for_input","message":"Which API should I bind?"}',
    );

    expect(client.generateJson).not.toHaveBeenCalled();
    expect(out.decision).toMatchObject({
      action: 'invoke_step',
      toolId: 'signal_blocked',
      args: {
        reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}Which API should I bind?`,
        category: 'missing_input',
      },
      reasoning: 'Ambiguous binding',
    });
    // The coerced call must clear the persistence gate (tool-arg validation included).
    expect(validateAgentDecisionForPersistence(params, ajvDeps, out.decision).kind).toBe(
      'accepted',
    );
  });

  it('throws after repair still invalid (invalid agent output)', async () => {
    const ctx = makeCtx();
    const params = baseAgentInput();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn(),
      validateToolArgs: () => null,
    };
    const client = {
      generateJson: vi.fn().mockResolvedValue({
        data: { action: 'still_bad' },
        rawContent: '{"action":"still_bad"}',
        model,
        provider,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    };

    await expect(
      parseGenerateJsonAgentDecision(
        ctx,
        deps,
        client as never,
        model,
        [],
        params,
        {
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model,
          provider,
        },
        { action: 'bad1' } as Record<string, unknown>,
        '{"action":"bad1"}',
      ),
    ).rejects.toThrow(InvalidAgentTurnDecisionError);
  });
});

describe('convertOrphanToolMessages', () => {
  it('never promotes orphan tool output to system role', () => {
    const out = convertOrphanToolMessages([
      {
        role: 'tool',
        toolCallId: 'orphan',
        name: 'ctx.tool',
        content: '{"x":1}',
      },
    ]);
    expect(out[0]!.role).not.toBe('system');
    expect(out[0]!.role).toBe('user');
  });
});

describe('prepareAgentRequest history hydration', () => {
  it('fails closed when a committed history batch ref cannot be retrieved', async () => {
    const mem = createMemoryPayloadStore();
    const missingBatchRef = 'gs://test-bucket/__missing_history_batch__' as PayloadRef;
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: `${tenantId}:${runId}:agent`,
      turnNumber: 0,
      context: {},
      history: {
        maxAtomsStructural: 200,
        atoms: [
          {
            atomId: 'atom-1',
            ref: missingBatchRef,
            role: 'user',
            hash: 'h',
            createdAtMs: 1,
          },
        ],
      },
      seenSourceIds: {},
    };
    const stateRef = await mem.store({
      tenantId: tenantId as TenantId,
      runId: runId as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      attempt: 1,
      kind: 'state',
      data: state,
    });

    const deps: HandlerDeps = {
      payloadStore: mem,
      handleError: vi.fn(),
      validateToolArgs: () => null,
    };
    const ctx = makeCtx();
    const params = baseAgentInput({ conversationStateRef: stateRef });

    await expect(
      prepareAgentRequest(ctx, deps, params, { useNativeFC: false }),
    ).rejects.toBeInstanceOf(ConversationHistoryHydrationError);
  });
});

describe('mergeCostBreakdown', () => {
  it('sums mediaCost when both sides contribute', () => {
    expect(
      mergeCostBreakdown(
        {
          promptCost: 1,
          completionCost: 2,
          totalCost: 3,
          currency: 'USD',
          mediaCost: 0.5,
        },
        {
          promptCost: 1,
          completionCost: 1,
          totalCost: 2,
          currency: 'USD',
          mediaCost: 0.25,
        },
      ),
    ).toEqual({
      promptCost: 2,
      completionCost: 3,
      totalCost: 5,
      currency: 'USD',
      mediaCost: 0.75,
    });
  });

  it('includes mediaCost when only one side has it', () => {
    expect(
      mergeCostBreakdown(
        { promptCost: 1, completionCost: 0, totalCost: 1, currency: 'USD', mediaCost: 0.1 },
        { promptCost: 0, completionCost: 1, totalCost: 1, currency: 'USD' },
      ),
    ).toEqual({
      promptCost: 1,
      completionCost: 1,
      totalCost: 2,
      currency: 'USD',
      mediaCost: 0.1,
    });
  });

  it('omits mediaCost when sum is zero', () => {
    expect(
      mergeCostBreakdown(
        { promptCost: 1, completionCost: 0, totalCost: 1, currency: 'USD' },
        { promptCost: 0, completionCost: 1, totalCost: 1, currency: 'USD' },
      ),
    ).toEqual({
      promptCost: 1,
      completionCost: 1,
      totalCost: 2,
      currency: 'USD',
    });
  });
});

describe('handleAgentTurn (integration seams)', () => {
  beforeEach(() => {
    vi.mocked(getAIClientForContext).mockReset();
  });

  it('returns SUCCEEDED on generateJson pause_for_input with valid client', async () => {
    const ctx = makeCtx();
    const payloadStore = createMemoryPayloadStore();
    const deps: HandlerDeps = {
      payloadStore,
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: model,
        provider,
        capabilities: { functionCalling: false },
      }),
      generateJson: vi.fn().mockResolvedValue({
        data: { action: 'pause_for_input', message: 'Hello user' },
        rawContent: '{"action":"pause_for_input","message":"Hello user"}',
        model,
        provider,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      }),
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput(), deps);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('does not succeed when decision is rejected after persistence repair (invoke_step bad args twice)', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: (stepId, args, inputSchema) => {
        const validate = new Ajv().compile(inputSchema);
        if (validate(args)) return null;
        return validationError('invalid args');
      },
    };

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: model,
        provider,
        capabilities: { functionCalling: false },
      }),
      generateJson: vi.fn().mockResolvedValue({
        data: { action: 'invoke_step', toolId: 'step-a', args: {} },
        rawContent: '{}',
        model,
        provider,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput(), deps);
    expect(result.status).toBe('FAILED');
  });

  it('succeeds when persistence repair fixes invalid tool args', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: (stepId, args, inputSchema) => {
        const validate = new Ajv().compile(inputSchema);
        if (validate(args)) return null;
        return validationError('invalid args');
      },
    };

    let call = 0;
    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: model,
        provider,
        capabilities: { functionCalling: false },
      }),
      generateJson: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            data: { action: 'invoke_step', toolId: 'step-a', args: {} },
            rawContent: '{"bad":true}',
            model,
            provider,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
        }
        return Promise.resolve({
          data: { action: 'pause_for_input', message: 'Need a valid q' },
          rawContent: '{"action":"pause_for_input","message":"Need a valid q"}',
          model,
          provider,
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        });
      }),
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput(), deps);
    expect(result.status).toBe('SUCCEEDED');
    expect(call).toBe(2);
  });

  it('rescues a pause returned by the persistence repair via the blocked-signal tool (never policy, no completion)', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: (_stepId, args, inputSchema) => {
        const validate = new Ajv().compile(inputSchema);
        if (validate(args)) return null;
        return validationError('invalid args');
      },
    };

    let call = 0;
    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: model,
        provider,
        capabilities: { functionCalling: false },
      }),
      generateJson: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) {
          // Missing required `q` → persistence reject → repair round.
          return Promise.resolve({
            data: { action: 'invoke_step', toolId: 'step-a', args: {} },
            rawContent: '{"bad":true}',
            model,
            provider,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
        }
        return Promise.resolve({
          data: { action: 'pause_for_input', message: 'I need the query value.' },
          rawContent: '{"action":"pause_for_input","message":"I need the query value."}',
          model,
          provider,
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        });
      }),
    } as never);

    const result = await handleAgentTurn(
      ctx,
      neverPolicyInput({
        availableTools: [...baseAgentInput().availableTools, signalBlockedToolSpec],
      }),
      deps,
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(call).toBe(2);
    const outputCall = vi
      .mocked(ctx.writePayload)
      .mock.calls.find(([kind]) => kind === 'output') as unknown as [string, { decision: unknown }];
    expect(outputCall[1].decision).toMatchObject({
      action: 'invoke_step',
      toolId: 'signal_blocked',
      args: {
        reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}I need the query value.`,
        category: 'missing_input',
      },
    });
  });

  it('keeps repairable_reject without the blocked-signal tool and persists the rejected decision in the final error', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    const pauseMessage = `Which API should I bind? ${'x'.repeat(2500)}`;
    const generateJson = vi.fn().mockResolvedValue({
      data: { action: 'pause_for_input', message: pauseMessage, reasoning: 'Stuck on binding' },
      rawContent: '{"action":"pause_for_input"}',
      model,
      provider,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: model,
        provider,
        capabilities: { functionCalling: false },
      }),
      generateJson,
    } as never);

    const result = await handleAgentTurn(ctx, neverPolicyInput(), deps);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    // First decision rejected + one persistence repair round that re-failed.
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(result.error.code).toBe('AGENT_DECISION_INVALID');
    const details = result.error.details as {
      reason: string;
      rejectedDecision?: { action: string; message?: string; reasoning?: string };
    };
    expect(details.reason).toMatch(/pause_for_input is not allowed/);
    expect(details.rejectedDecision).toBeDefined();
    expect(details.rejectedDecision?.action).toBe('pause_for_input');
    expect(details.rejectedDecision?.message).toBe(pauseMessage.slice(0, 2000));
    expect(details.rejectedDecision?.reasoning).toBe('Stuck on binding');
  });

  it('live delta emission failure does not fail the step (native FC path)', async () => {
    const ctx = makeCtx();
    // Streaming output is a side channel: the turn's result does not depend on
    // a visitor having seen it arrive. Deltas moved off the event stream onto
    // emitLiveDelta, so that is the seam that has to be allowed to fail here.
    (ctx as { emitLiveDelta: unknown }).emitLiveDelta = vi
      .fn()
      .mockRejectedValue(new Error('live plane down'));
    ctx.emitRunEvent = vi.fn().mockRejectedValue(new Error('sse down'));
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    async function* emptyStream() {
      yield { type: 'text_delta' as const, delta: 'hi' };
    }

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: 'claude-3-test',
        provider: 'anthropic',
        capabilities: { functionCalling: true },
      }),
      generateTextStream: vi.fn().mockReturnValue({
        stream: emptyStream(),
        response: Promise.resolve({
          content: null,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model,
          provider: 'anthropic',
        }),
      }),
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput(), deps);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('routes OpenAI models with functionCalling capability through native FC (generateTextStream)', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    async function* stream() {
      yield { type: 'text_delta' as const, delta: 'thinking…' };
    }

    const generateTextStream = vi.fn().mockReturnValue({
      stream: stream(),
      response: Promise.resolve({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'pause_for_input', arguments: '{"message":"need input"}' },
          },
        ],
        finishReason: 'tool_calls' as const,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'gpt-5.6-terra',
        provider: 'openai',
      }),
    });
    const generateJson = vi.fn();

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: 'gpt-5.6-terra',
        provider: 'openai',
        capabilities: { functionCalling: true },
      }),
      generateTextStream,
      generateJson,
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput({ model: 'gpt-5.6-terra' }), deps);
    expect(result.status).toBe('SUCCEEDED');
    expect(generateTextStream).toHaveBeenCalledTimes(1);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('routes xAI through native FC so tool-loop reasoning is on the Responses path', async () => {
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    async function* stream() {
      yield { type: 'text_delta' as const, delta: '' };
    }

    const generateTextStream = vi.fn().mockReturnValue({
      stream: stream(),
      response: Promise.resolve({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'pause_for_input', arguments: '{"message":"need input"}' },
          },
        ],
        finishReason: 'tool_calls' as const,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'grok-4.7',
        provider: 'xai',
      }),
    });
    const generateJson = vi.fn();

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: 'grok-4.7',
        provider: 'xai',
        capabilities: { functionCalling: true, reasoning: true },
      }),
      generateTextStream,
      generateJson,
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput({ model: 'grok-4.7' }), deps);
    expect(result.status).toBe('SUCCEEDED');
    expect(generateTextStream).toHaveBeenCalledTimes(1);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('repairs invalid tool args via native FC (re-issues generateTextStream, never generateJson)', async () => {
    // The structured-output repair drives the model with a generic agent-decision
    // schema whose `args` is unconstrained — a strict model returns empty args and
    // fails again. For native-FC providers the repair must re-issue via native FC
    // so the tool's required-argument schema is back in front of the model.
    const ctx = makeCtx();
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockImplementation(async (_c, _l, e) => {
        throw e;
      }),
      validateToolArgs: (_stepId, args, inputSchema) => {
        const validate = new Ajv().compile(inputSchema);
        if (validate(args)) return null;
        return validationError('invalid args');
      },
    };

    async function* stream() {
      yield { type: 'text_delta' as const, delta: '' };
    }

    let call = 0;
    const generateTextStream = vi.fn().mockImplementation(() => {
      call += 1;
      // Call 1: tool call missing required `q` → rejected. Call 2 (repair):
      // the same tool with `q` populated → accepted.
      const args = call === 1 ? '{}' : '{"q":"fixed"}';
      return {
        stream: stream(),
        response: Promise.resolve({
          content: null,
          toolCalls: [
            {
              id: `c${String(call)}`,
              type: 'function' as const,
              function: { name: 'step_a', arguments: args },
            },
          ],
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          model: 'gpt-5.6-terra',
          provider: 'openai',
        }),
      };
    });
    const generateJson = vi.fn();

    vi.mocked(getAIClientForContext).mockResolvedValue({
      getModel: () => ({
        id: 'gpt-5.6-terra',
        provider: 'openai',
        capabilities: { functionCalling: true },
      }),
      generateTextStream,
      generateJson,
    } as never);

    const result = await handleAgentTurn(ctx, baseAgentInput({ model: 'gpt-5.6-terra' }), deps);
    expect(result.status).toBe('SUCCEEDED');
    expect(generateTextStream).toHaveBeenCalledTimes(2); // original + native-FC repair
    expect(generateJson).not.toHaveBeenCalled(); // repair did NOT fall back to structured output
    expect(call).toBe(2);
  });

  it('routes AI client bootstrap failures through handleError', async () => {
    const ctx = makeCtx();
    const failureResult = {
      status: 'FAILED',
      error: validationError('bootstrap failed'),
      errorRef: 'inline:test' as PayloadRef,
      durationMs: 0,
    } as const;
    const deps: HandlerDeps = {
      payloadStore: createMemoryPayloadStore(),
      handleError: vi.fn().mockResolvedValue(failureResult),
      validateToolArgs: () => null,
    };

    vi.mocked(getAIClientForContext).mockRejectedValue(
      new Error('credential bootstrap failed before model execution'),
    );

    const result = await handleAgentTurn(ctx, baseAgentInput(), deps);
    expect(deps.handleError).toHaveBeenCalledWith(ctx, 'Agent turn failed', expect.any(Error));
    expect(result).toBe(failureResult);
  });
});
