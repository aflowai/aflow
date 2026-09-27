import { describe, it, expect, vi } from 'vitest';
import type {
  AgentToolSpec,
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
  TenantId,
  SessionId,
  StepExecutionId,
} from '@aflow/schemas';
import { textMessage, toolResultMessage, MEMORY_READ_OPERATION_ID } from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AIClient } from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import { RETENTION_POLICY } from './retentionPolicy.js';
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

function userAtom(turnNumber: number, text = 'TASK: optimize the model'): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `user-${String(turnNumber)}`,
    role: 'user',
    sourceId: `u${String(turnNumber)}`,
    sourceKind: 'user_input',
    message: textMessage('user', text),
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function assistantTextAtom(turnNumber: number, text = 'thinking'): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-text-${String(turnNumber)}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [
        { kind: 'text', text },
        { kind: 'json', json: { action: 'pause_for_input', message: text } },
      ],
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function assistantToolAtom(turnNumber: number, base: string, names: string[]): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_steps' } }],
      toolCalls: names.map((name, i) => ({
        toolCallId: `${base}_${String(i)}`,
        name,
        argumentsJson: { q: `lookup-${base}-${String(i)}` },
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
  opts: {
    toolName: string;
    operationId?: string;
    summaryChars?: number;
    failed?: boolean;
  },
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

function makeState(
  atoms: AiMessageAtomV1[],
  turnNumber: number,
  batchRef = 'batch:1',
): AiConversationStateV1 {
  return {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    history: {
      maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
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

async function makeStoreAndAssemble(fullAtoms: AiMessageAtomV1[], turnNumber: number) {
  const retrieve = vi.fn().mockResolvedValue(fullAtoms);
  const storeFn = vi.fn().mockResolvedValue('ref:new');
  const state = makeState(fullAtoms, turnNumber);
  const store = new ConversationStateStore(
    { ...baseConfig, payloadStore: { retrieve, store: storeFn } as unknown as PayloadStore },
    state,
  );
  await store.assembleRequest('sys', []);
  return { store, storeFn, state };
}

// ============================================================================
// §4.2 — below clearHighWater nothing happens
// ============================================================================

describe('clearUnderPressure — low pressure (§4.2 corollary)', () => {
  it('keeps a 15-turn low-utilization conversation byte-identical', async () => {
    const atoms: AiMessageAtomV1[] = [userAtom(0)];
    for (let t = 1; t <= 14; t++) {
      const base = `lo${String(t).padStart(2, '0')}`;
      atoms.push(assistantToolAtom(t, base, ['memory.store.query']));
      atoms.push(
        resultAtom(t, base, 0, {
          toolName: 'memory.store.query',
          operationId: 'memory.store.query',
          summaryChars: 2000,
        }),
      );
    }
    const { store, storeFn, state } = await makeStoreAndAssemble(atoms, 15);
    const before = JSON.stringify(state);

    const result = await store.clearUnderPressure({
      pressureTokens: 2_000, // 0.2 utilization — every exchange is fully aged, yet nothing clears
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(result).toBeUndefined();
    expect(JSON.stringify(store.getState())).toBe(before);
    expect(storeFn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// §4.3 — greedy clearing to clearLowWater in protection-class order
// ============================================================================

describe('clearUnderPressure — greedy class-ranked clearing (§4.3)', () => {
  function classOrderAtoms(): AiMessageAtomV1[] {
    const atoms: AiMessageAtomV1[] = [userAtom(0)];
    // exA: idempotent, big savings (class 1, ranked first)
    atoms.push(assistantToolAtom(1, 'exA', ['memory.store.query']));
    atoms.push(
      resultAtom(1, 'exA', 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 10_500,
      }),
    );
    // exB: idempotent, smaller savings (class 1, ranked second by savings DESC)
    atoms.push(assistantToolAtom(2, 'exB', ['memory.store.get']));
    atoms.push(
      resultAtom(2, 'exB', 0, {
        toolName: 'memory.store.get',
        operationId: 'memory.store.get',
        summaryChars: 3_500,
      }),
    );
    // exC: unknown idempotency — catalog lookup miss (class 2)
    atoms.push(assistantToolAtom(3, 'exC', ['mystery.tool']));
    atoms.push(
      resultAtom(3, 'exC', 0, {
        toolName: 'mystery.tool',
        operationId: 'no.such.operation',
        summaryChars: 10_500,
      }),
    );
    // exD: non-idempotent (class 3) — clearing invites re-execution
    atoms.push(assistantToolAtom(4, 'exD', ['compute.sandbox.exec']));
    atoms.push(
      resultAtom(4, 'exD', 0, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        summaryChars: 10_500,
      }),
    );
    // exE: failed (class 4) — one of two parallel calls failed; the failure
    // protects the WHOLE exchange
    atoms.push(assistantToolAtom(5, 'exE', ['memory.store.query', 'compute.sandbox.exec']));
    atoms.push(
      resultAtom(5, 'exE', 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 10_500,
      }),
    );
    atoms.push(
      resultAtom(5, 'exE', 1, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        failed: true,
      }),
    );
    // exR: idempotent + huge but RECENT (turn 18 of 20) — Tier-1 protected
    atoms.push(assistantToolAtom(18, 'exR', ['memory.store.query']));
    atoms.push(
      resultAtom(18, 'exR', 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 10_500,
      }),
    );
    return atoms;
  }

  it('clears exactly to clearLowWater in class order — non-idempotent and failed survive idempotent', async () => {
    const { store } = await makeStoreAndAssemble(classOrderAtoms(), 20);
    const effectiveBudget = 10_000;
    const pressureTokens = 9_500;

    const result = await store.clearUnderPressure({
      pressureTokens,
      effectiveBudget,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(result).toBeDefined();

    // Class order: idempotent (savings DESC: exA then exB), then unknown (exC).
    // The ledger reaches clearLowWater after exC — exD/exE are candidates but
    // are never touched (hysteresis stop, classes 3/4 ranked last).
    expect(store.getState().clearing?.clearedExchanges).toEqual(['exA', 'exB', 'exC']);

    const ids = new Set(store.getState().history.atoms.map((a) => a.atomId));
    expect(ids.has('asst-exD')).toBe(true); // non-idempotent survives
    expect(ids.has('res-exD-0')).toBe(true);
    expect(ids.has('asst-exE')).toBe(true); // failed survives
    expect(ids.has('res-exE-1')).toBe(true);
    expect(ids.has('asst-exR')).toBe(true); // recent survives (Tier 1)
    expect(ids.has('user-0')).toBe(true); // pinned opener survives (Tier 0)
    expect(ids.has('asst-exA')).toBe(false);
    expect(ids.has('asst-exB')).toBe(false);
    expect(ids.has('asst-exC')).toBe(false);

    // Hysteresis: the estimated post-clearing pressure is at/below the low watermark.
    expect(pressureTokens - result!.estimatedTokensFreed).toBeLessThanOrEqual(
      RETENTION_POLICY.clearLowWater * effectiveBudget,
    );
  });

  it('net-savings rule: small exchanges are never candidates, even under pressure', async () => {
    const atoms: AiMessageAtomV1[] = [userAtom(0)];
    for (let t = 1; t <= 10; t++) {
      const base = `sm${String(t).padStart(2, '0')}`;
      atoms.push(assistantToolAtom(t, base, ['memory.store.query']));
      atoms.push(
        resultAtom(t, base, 0, {
          toolName: 'memory.store.query',
          operationId: 'memory.store.query',
          summaryChars: 40, // a note would cost more than it saves
        }),
      );
    }
    const { store, state } = await makeStoreAndAssemble(atoms, 20);
    const before = JSON.stringify(state);

    const result = await store.clearUnderPressure({
      pressureTokens: 9_500,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(result).toBeUndefined();
    expect(JSON.stringify(store.getState())).toBe(before);
  });
});

// ============================================================================
// §4.8 — the Tier-3 compaction decision uses the post-clearing number
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

function baseAgentInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'Do the thing',
    availableTools: [],
    policy: { maxToolCallsPerTurn: 5, allowParallel: true, maxParallel: 2, allowComplete: true },
    turnNumber: 0,
    model: 'test-model',
    ...overrides,
  };
}

async function seedConversation(
  mem: PayloadStore,
  atoms: AiMessageAtomV1[],
  turnNumber: number,
): Promise<string> {
  const batchRef = await mem.store({
    tenantId: 'tenant-test' as TenantId,
    runId: 'run-test' as SessionId,
    stepExecutionId: 'seed' as StepExecutionId,
    attempt: 1,
    kind: 'history',
    data: atoms,
  });
  const state = makeState(atoms, turnNumber, batchRef);
  state.conversationId = 'tenant-test:run-test:agent-1';
  return await mem.store({
    tenantId: 'tenant-test' as TenantId,
    runId: 'run-test' as SessionId,
    stepExecutionId: 'seed' as StepExecutionId,
    attempt: 1,
    kind: 'state',
    data: state,
  });
}

// effectiveBudget for the 200k fallback window: 200000 − 4096 − 10000 = 185904.
// compactHighWater bar: 130_132.8 tokens.
function compactionScenarioAtoms(): AiMessageAtomV1[] {
  const atoms: AiMessageAtomV1[] = [userAtom(0)];
  // Three big idempotent exchanges — clearing frees ≈3 × ~2k tokens.
  for (let t = 2; t <= 4; t++) {
    const base = `cx${String(t)}`;
    atoms.push(assistantToolAtom(t, base, ['memory.store.query']));
    atoms.push(
      resultAtom(t, base, 0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 7_000,
      }),
    );
  }
  // Text-only middle narrative (turns 5..10) — compaction's range when it fires.
  for (let t = 5; t <= 10; t++) {
    atoms.push(t % 2 === 0 ? userAtom(t, `note ${String(t)}`) : assistantTextAtom(t));
  }
  return atoms;
}

async function runTurn(promptTokens: number, availableTools: AgentToolSpec[] = []) {
  const mem = createMemoryPayloadStore();
  const stateRef = await seedConversation(mem, compactionScenarioAtoms(), 20);
  const writes: Array<{ kind: string; data: unknown }> = [];
  const ctx = makeCtx(writes);
  const client = mockClient(promptTokens);
  vi.mocked(getAIClientForContext).mockResolvedValue(client);
  const deps: HandlerDeps = {
    payloadStore: mem,
    handleError: vi.fn().mockImplementation((_c, _l, e: unknown) => {
      throw e;
    }),
    validateToolArgs: () => null,
  };

  const result = await handleAgentTurn(
    ctx,
    baseAgentInput({ conversationStateRef: stateRef, turnNumber: 20, availableTools }),
    deps,
  );
  expect(result.status).toBe('SUCCEEDED');
  const output = writes.find((w) => w.kind === 'output')?.data as {
    contextEngineering?: {
      clearing?: { clearedExchanges: number };
      compaction?: { compactionNumber: number };
    };
  };
  return { output, client, ctx };
}

describe('finishAgentTurn — Tier-3 trigger on the post-clearing ledger (§4.8)', () => {
  it('clearing that relieves pressure below compactHighWater suppresses compaction', async () => {
    // 134k provider-reported tokens: above compactHighWater (130.1k) at assembly,
    // but clearing frees ~6k — the POST-clearing number is below the bar.
    const { output, client } = await runTurn(134_000);

    expect(output.contextEngineering?.clearing?.clearedExchanges).toBe(3);
    expect(output.contextEngineering?.compaction).toBeUndefined();
    expect(
      (client as unknown as { generateText: ReturnType<typeof vi.fn> }).generateText,
    ).not.toHaveBeenCalled();
  });

  it('compaction still fires when the post-clearing number stays above the bar', async () => {
    // 140k: clearing frees the same ~6k, post-clearing ≈134k — still above 130.1k.
    const { output, client } = await runTurn(140_000);

    expect(output.contextEngineering?.clearing?.clearedExchanges).toBe(3);
    expect(output.contextEngineering?.compaction).toBeDefined();
    expect(
      (client as unknown as { generateText: ReturnType<typeof vi.fn> }).generateText,
    ).toHaveBeenCalled();
  });
});

// ============================================================================
// §4.9 — honest degrade counter when the read op is off the tool surface
// ============================================================================

const memoryReadTool = {
  toolId: 'memory.store.get',
  kind: 'virtual',
  lowering: 'run_step',
  operationId: 'memory.store.get',
  stepType: 'memory',
  name: 'Get Memory Document',
  inputSchema: {},
} as AgentToolSpec;

describe('finishAgentTurn — §4.9 degrade counter', () => {
  it('logs agent_turn_note_readop_missing when clearing runs without the read op', async () => {
    const { ctx } = await runTurn(134_000);
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'agent_turn_note_readop_missing',
      expect.objectContaining({ clearedExchanges: 3 }),
    );
  });

  it('stays silent when memory.store.get is on the tool surface', async () => {
    const { output, ctx } = await runTurn(134_000, [memoryReadTool]);
    expect(output.contextEngineering?.clearing?.clearedExchanges).toBe(3);
    expect(ctx.log.warn).not.toHaveBeenCalledWith(
      'agent_turn_note_readop_missing',
      expect.anything(),
    );
  });
});
