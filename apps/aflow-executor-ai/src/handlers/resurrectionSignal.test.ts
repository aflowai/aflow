import { describe, it, expect, vi } from 'vitest';
import type {
  AgentToolSpec,
  AiClearingStateV1,
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
  TenantId,
  SessionId,
  StepExecutionId,
} from '@aflow/schemas';
import {
  AiClearingStateV1Schema,
  AiConversationStateV1Schema,
  computeToolCallArgsHash,
  textMessage,
  toolResultMessage,
  MEMORY_READ_OPERATION_ID,
} from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AIClient } from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import type { HandlerDeps } from './ai/handlers/types.js';
import type { AgentTurnInput } from './ai/schema.js';
import { handleAgentTurn } from './ai/handlers/agentTurn.js';
import { getAIClientForContext } from './ai/aiClient.js';

vi.mock('./ai/aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

// ============================================================================
// Fixtures
// ============================================================================

const RES = 'r'.repeat(32); // re-executing exchange
const IDEM = 'a'.repeat(32); // idempotent exchange (class 1)
const UNK = 'c'.repeat(32); // unknown-idempotency exchange (class 2)
const FAIL = 'f'.repeat(32); // failed exchange (class 4)
const GET = 'g'.repeat(32); // memory.store.get re-fetch exchange

function userAtom(turnNumber: number): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `user-${String(turnNumber)}`,
    role: 'user',
    sourceId: `u${String(turnNumber)}`,
    sourceKind: 'user_input',
    message: textMessage('user', 'TASK: optimize the model'),
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function assistantAtom(
  turnNumber: number,
  base: string,
  calls: Array<{ name: string; args: unknown }>,
): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_steps' } }],
      toolCalls: calls.map((c, i) => ({
        toolCallId: `${base}_${String(i)}`,
        name: c.name,
        argumentsJson: c.args,
      })),
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function resultAtom(
  turnNumber: number,
  base: string,
  i: number,
  opts: { toolName: string; operationId?: string; summaryChars?: number; failed?: boolean },
): AiMessageAtomV1 {
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${base}_${String(i)}`,
    toolName: opts.toolName,
    ...(opts.operationId ? { operationId: opts.operationId } : {}),
    status: opts.failed ? 'FAILED' : 'SUCCEEDED',
    ...(opts.failed
      ? { error: { error: 'unavailable', message: 'boom', retry: false } }
      : {
          outputRef: `output.${base}_${String(i)}/data`,
          summary: 'r'.repeat(opts.summaryChars ?? 200),
        }),
  };
  return {
    schemaVersion: 1,
    atomId: `res-${base}-${String(i)}`,
    role: 'tool',
    sourceId: `${base}_${String(i)}`,
    sourceKind: 'tool_result',
    message: toolResultMessage(envelope),
    createdAtMs: turnNumber * 1000 + 1 + i,
    turnNumber,
  };
}

function clearedExecCall(
  argsHash: string | undefined,
  clearedAtMs: number,
): AiClearingStateV1['clearedCalls'][number] {
  return {
    exchangeKey: 'oldex',
    toolCallId: 'oldex_0',
    toolName: 'compute.sandbox.exec',
    ...(argsHash !== undefined ? { argsHash } : {}),
    clearedAtMs,
  };
}

function makeState(
  atoms: AiMessageAtomV1[],
  turnNumber: number,
  clearing?: AiClearingStateV1,
  batchRef = 'batch:1',
): AiConversationStateV1 {
  return {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    ...(clearing ? { clearing } : {}),
    history: {
      maxAtomsStructural: 200,
      atoms: atoms.map((a) => ({
        atomId: a.atomId,
        ref: batchRef,
        role: a.role,
        sourceKind: a.sourceKind,
        hash: 'h',
        createdAtMs: a.createdAtMs,
        ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
      })),
    },
  };
}

const baseConfig = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  stepId: 'agent',
  stepExecutionId: 'step-exec-uuid',
  attempt: 1,
};

async function makeStoreAndAssemble(
  fullAtoms: AiMessageAtomV1[],
  turnNumber: number,
  clearing?: AiClearingStateV1,
) {
  const retrieve = vi.fn().mockResolvedValue(fullAtoms);
  const storeFn = vi.fn().mockResolvedValue('ref:new');
  const state = makeState(fullAtoms, turnNumber, clearing);
  const store = new ConversationStateStore(
    { ...baseConfig, payloadStore: { retrieve, store: storeFn } as unknown as PayloadStore },
    state,
  );
  await store.assembleRequest('sys', []);
  return { store, storeFn, state };
}

const overPressure = {
  pressureTokens: 9_500,
  effectiveBudget: 10_000,
  availableReadOpId: MEMORY_READ_OPERATION_ID,
};

// ============================================================================
// argsHash stability
// ============================================================================

describe('computeToolCallArgsHash (§4.6)', () => {
  it('is insensitive to object key order, recursively', () => {
    const a = computeToolCallArgsHash('t', { a: 1, b: { c: 2, d: [1, 2] }, e: 'x' });
    const b = computeToolCallArgsHash('t', { e: 'x', b: { d: [1, 2], c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('differs across tool names and across argument values', () => {
    expect(computeToolCallArgsHash('t1', { a: 1 })).not.toBe(
      computeToolCallArgsHash('t2', { a: 1 }),
    );
    expect(computeToolCallArgsHash('t', { a: 1 })).not.toBe(computeToolCallArgsHash('t', { a: 2 }));
  });

  it('keeps array order significant', () => {
    expect(computeToolCallArgsHash('t', { a: [1, 2] })).not.toBe(
      computeToolCallArgsHash('t', { a: [2, 1] }),
    );
  });
});

// ============================================================================
// §4.6 — re-execution detection + class-5 ranking
// ============================================================================

describe('clearUnderPressure — re-execution of a cleared call (§4.6)', () => {
  function rankingAtoms(): AiMessageAtomV1[] {
    return [
      userAtom(0),
      // Re-executes the cleared compute.sandbox.exec call — args key order permuted.
      assistantAtom(5, RES, [{ name: 'compute.sandbox.exec', args: { b: 2, a: 1 } }]),
      resultAtom(5, RES, 0, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        summaryChars: 8_000,
      }),
      assistantAtom(7, IDEM, [{ name: 'memory.store.query', args: { q: 'x' } }]),
      resultAtom(7, IDEM, 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 8_000,
      }),
      assistantAtom(8, UNK, [{ name: 'mystery.tool', args: { q: 'y' } }]),
      resultAtom(8, UNK, 0, {
        toolName: 'mystery.tool',
        operationId: 'no.such.operation',
        summaryChars: 8_000,
      }),
      assistantAtom(9, FAIL, [
        { name: 'memory.store.query', args: { q: 'z' } },
        { name: 'compute.sandbox.exec', args: { code: 'x' } },
      ]),
      resultAtom(9, FAIL, 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 8_000,
      }),
      resultAtom(9, FAIL, 1, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        failed: true,
      }),
    ];
  }

  function rankingClearing(): AiClearingStateV1 {
    return {
      ranges: [],
      clearedExchanges: ['oldex'],
      clearedCalls: [
        clearedExecCall(computeToolCallArgsHash('compute.sandbox.exec', { a: 1, b: 2 }), 1_500),
      ],
      resurrectedExchanges: [],
    };
  }

  it('increments the counter, marks the new exchange, and ranks it last-to-clear (class 5)', async () => {
    const { store } = await makeStoreAndAssemble(rankingAtoms(), 20, rankingClearing());

    const result = await store.clearUnderPressure(overPressure);

    expect(result).toMatchObject({ reexecutions: 1, refetches: 0 });
    const state = store.getState();
    expect(state.clearing?.resurrectedExchanges).toEqual([RES]);

    // Greedy clears idempotent → unknown → failed, then stops at the low
    // watermark — the resurrected exchange (class 5) outlives even the failed
    // one (class 4), though its natural class would be 3.
    expect(state.clearing?.clearedExchanges).toEqual(['oldex', IDEM, UNK, FAIL]);
    const ids = new Set(state.history.atoms.map((a) => a.atomId));
    expect(ids.has(`asst-${RES}`)).toBe(true);
    expect(ids.has(`res-${RES}-0`)).toBe(true);
  });

  it('never re-counts a marked exchange on later passes; clearing it records its calls', async () => {
    const { store } = await makeStoreAndAssemble(rankingAtoms(), 20, rankingClearing());
    await store.clearUnderPressure(overPressure);

    const second = await store.clearUnderPressure(overPressure);

    expect(second).toMatchObject({ clearedExchangeCount: 1, reexecutions: 0, refetches: 0 });
    const clearing = store.getState().clearing;
    expect(clearing?.clearedExchanges).toContain(RES);
    expect(clearing?.clearedCalls.some((c) => c.exchangeKey === RES)).toBe(true);
  });

  it('does not count matches older than the clear', async () => {
    const clearing = rankingClearing();
    clearing.clearedCalls = [
      clearedExecCall(computeToolCallArgsHash('compute.sandbox.exec', { a: 1, b: 2 }), 99_999_999),
    ];
    const { store } = await makeStoreAndAssemble(rankingAtoms(), 20, clearing);

    const result = await store.clearUnderPressure(overPressure);

    expect(result).toMatchObject({ reexecutions: 0, refetches: 0 });
    expect(store.getState().clearing?.resurrectedExchanges).toEqual([]);
  });
});

// ============================================================================
// §4.6 — re-fetch detection on the /run/outputs read path
// ============================================================================

describe('clearUnderPressure — re-fetch of a cleared output (§4.6)', () => {
  it('detects /run/outputs/<clearedToolCallId> reads and persists detection-only passes', async () => {
    const clearing: AiClearingStateV1 = {
      ranges: [],
      clearedExchanges: ['oldex'],
      // Result-only cleared call (no argsHash) — re-fetch matches by toolCallId.
      clearedCalls: [clearedExecCall(undefined, 1_500)],
      resurrectedExchanges: [],
    };
    const atoms = [
      userAtom(0),
      assistantAtom(5, GET, [
        { name: 'memory.store.get', args: { path: '/run/outputs/oldex_0/data', view: 'outline' } },
      ]),
      // Small result — never a clearing candidate, so this pass clears nothing.
      resultAtom(5, GET, 0, {
        toolName: 'memory.store.get',
        operationId: 'memory.store.get',
        summaryChars: 40,
      }),
    ];
    const { store, storeFn } = await makeStoreAndAssemble(atoms, 20, clearing);

    const result = await store.clearUnderPressure(overPressure);

    expect(result).toMatchObject({
      clearedExchangeCount: 0,
      atomsSummarized: 0,
      estimatedTokensFreed: 0,
      reexecutions: 0,
      refetches: 1,
    });
    expect(store.getState().clearing?.resurrectedExchanges).toEqual([GET]);
    // The mark survives the pass even though nothing was cleared.
    expect(storeFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'state' }));
  });

  it('ignores memory.store.get reads of non-cleared paths', async () => {
    const clearing: AiClearingStateV1 = {
      ranges: [],
      clearedExchanges: ['oldex'],
      clearedCalls: [clearedExecCall(undefined, 1_500)],
      resurrectedExchanges: [],
    };
    const atoms = [
      userAtom(0),
      assistantAtom(5, GET, [
        { name: 'memory.store.get', args: { path: '/run/outputs/other_3/data' } },
        { name: 'memory.store.get', args: { path: '/spaces/notes.md' } },
      ]),
      resultAtom(5, GET, 0, {
        toolName: 'memory.store.get',
        operationId: 'memory.store.get',
        summaryChars: 40,
      }),
    ];
    const { store, storeFn, state } = await makeStoreAndAssemble(atoms, 20, clearing);
    const before = JSON.stringify(state);

    const result = await store.clearUnderPressure(overPressure);

    expect(result).toBeUndefined();
    expect(JSON.stringify(store.getState())).toBe(before);
    expect(storeFn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Schema — clearing state carries the §4.6 index
// ============================================================================

describe('clearing state schema (§4.6)', () => {
  it('round-trips clearedCalls and resurrectedExchanges through the conversation state', () => {
    const parsed = AiConversationStateV1Schema.safeParse({
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 5,
      context: {},
      history: { atoms: [], maxAtomsStructural: 200 },
      seenSourceIds: {},
      clearing: {
        ranges: [],
        clearedExchanges: ['oldex'],
        clearedCalls: [clearedExecCall('abcd1234', 123)],
        resurrectedExchanges: [RES],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.clearing?.clearedCalls).toEqual([clearedExecCall('abcd1234', 123)]);
      expect(parsed.data.clearing?.resurrectedExchanges).toEqual([RES]);
    }
  });

  it('defaults the §4.6 fields for clearing states that predate them', () => {
    const parsed = AiClearingStateV1Schema.parse({ ranges: [], clearedExchanges: ['x'] });
    expect(parsed.clearedCalls).toEqual([]);
    expect(parsed.resurrectedExchanges).toEqual([]);
  });
});

// ============================================================================
// Per-turn structured-log counters (alongside agent_turn_history_cleared)
// ============================================================================

function makeCtx(writes: Array<{ kind: string; data: unknown }>): ExecutorContext {
  return {
    job: {
      tenantId: 'tenant-test',
      runId: 'run-test',
      stepId: 'agent-1',
      stepExecutionId: 'exec-final',
      attempt: 1,
    },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    runId: 'run-test',
    emitRunEvent: vi.fn().mockResolvedValue(undefined),
    writePayload: vi.fn().mockImplementation((kind: string, data: unknown) => {
      writes.push({ kind, data });
      return Promise.resolve('inline:test');
    }),
  } as unknown as ExecutorContext;
}

function mockClient(promptTokens: number): AIClient {
  return {
    getModel: (m: string) => ({
      id: m,
      provider: 'openai',
      capabilities: { functionCalling: false },
    }),
    generateJson: vi.fn().mockResolvedValue({
      data: { action: 'pause_for_input', message: 'ok' },
      rawContent: '{"action":"pause_for_input","message":"ok"}',
      model: 'test-model',
      provider: 'openai',
      usage: { promptTokens, completionTokens: 5, totalTokens: promptTokens + 5 },
    }),
    generateText: vi.fn().mockResolvedValue({
      content: '## What Was Accomplished\n- compressed',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      model: 'flash-lite',
      provider: 'google',
    }),
  } as unknown as AIClient;
}

const memoryReadTool = {
  toolId: 'memory.store.get',
  kind: 'virtual',
  lowering: 'run_step',
  operationId: 'memory.store.get',
  stepType: 'memory',
  name: 'Get Memory Document',
  inputSchema: {},
} as AgentToolSpec;

describe('finishAgentTurn — §4.6 counters in agent_turn_history_cleared', () => {
  it('logs agent_turn_cleared_reexecution alongside the Plan 189 §7.5 fields', async () => {
    const atoms = [
      userAtom(0),
      assistantAtom(2, RES, [{ name: 'compute.sandbox.exec', args: { x: 1 } }]),
      resultAtom(2, RES, 0, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        summaryChars: 7_000,
      }),
      assistantAtom(3, IDEM, [{ name: 'memory.store.query', args: { q: 'a' } }]),
      resultAtom(3, IDEM, 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 7_000,
      }),
      assistantAtom(4, UNK, [{ name: 'memory.store.query', args: { q: 'b' } }]),
      resultAtom(4, UNK, 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 7_000,
      }),
    ];
    const clearing: AiClearingStateV1 = {
      ranges: [],
      clearedExchanges: ['oldex'],
      clearedCalls: [
        clearedExecCall(computeToolCallArgsHash('compute.sandbox.exec', { x: 1 }), 1_000),
      ],
      resurrectedExchanges: [],
    };

    const mem = createMemoryPayloadStore();
    const batchRef = await mem.store({
      tenantId: 'tenant-test' as TenantId,
      runId: 'run-test' as SessionId,
      stepExecutionId: 'seed' as StepExecutionId,
      attempt: 1,
      kind: 'history',
      data: atoms,
    });
    const state = makeState(atoms, 20, clearing, batchRef);
    state.conversationId = 'tenant-test:run-test:agent-1';
    const stateRef = await mem.store({
      tenantId: 'tenant-test' as TenantId,
      runId: 'run-test' as SessionId,
      stepExecutionId: 'seed' as StepExecutionId,
      attempt: 1,
      kind: 'state',
      data: state,
    });

    const writes: Array<{ kind: string; data: unknown }> = [];
    const ctx = makeCtx(writes);
    vi.mocked(getAIClientForContext).mockResolvedValue(mockClient(134_000));
    const deps: HandlerDeps = {
      payloadStore: mem,
      handleError: vi.fn().mockImplementation((_c, _l, e: unknown) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };
    const input: AgentTurnInput = {
      prompt: 'Do the thing',
      availableTools: [memoryReadTool],
      policy: { maxToolCallsPerTurn: 5, allowParallel: true, maxParallel: 2, allowComplete: true },
      turnNumber: 20,
      model: 'test-model',
      conversationStateRef: stateRef,
    };

    const result = await handleAgentTurn(ctx, input, deps);
    expect(result.status).toBe('SUCCEEDED');

    expect(ctx.log.info).toHaveBeenCalledWith(
      'agent_turn_history_cleared',
      expect.objectContaining({
        clearedExchanges: 3,
        agent_turn_cleared_reexecution: 1,
        agent_turn_cleared_refetch: 0,
      }),
    );
  });
});
