import { describe, it, expect, vi } from 'vitest';
import type {
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
  CompactionArtifact,
  TenantId,
  SessionId,
  StepExecutionId,
} from '@aflow/schemas';
import { textMessage, toolResultMessage, MEMORY_READ_OPERATION_ID } from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AIClient, ChatMessage } from '@aflow/ai-client';
import {
  toGeminiContents,
  toAnthropicMessages,
  checkGeminiContentsWireValidity,
  checkAnthropicMessagesWireValidity,
  TRUNCATED_HISTORY_USER_BRIDGE_TEXT,
} from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import { computePinnedAtomIds, RETENTION_POLICY } from './retentionPolicy.js';
import {
  aiMessageToChatMessage,
  mergeConsecutiveMessages,
} from './ai/handlers/agentMessageConversion.js';
import {
  convertOrphanToolMessages,
  enforceToolResultAdjacency,
} from './ai/handlers/nativeFcMessagePatch.js';
import type { HandlerDeps } from './ai/handlers/types.js';
import type { AgentTurnInput } from './ai/schema.js';
import { handleAgentTurn } from './ai/handlers/agentTurn.js';
import { getAIClientForContext } from './ai/aiClient.js';

vi.mock('./ai/aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));
import { logWireBridgeIfFiring } from './ai/handlers/agentTurnModel.js';

// ============================================================================
// Fixtures
// ============================================================================

const OPENING_INSTRUCTION = 'TASK INSTRUCTION: hydrate the market briefing for today';

function userAtom(turnNumber: number, text = 'go'): AiMessageAtomV1 {
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

function assistantTextAtom(turnNumber: number, text = 'working on it'): AiMessageAtomV1 {
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

function assistantToolAtom(turnNumber: number, base: string, name: string): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_step', toolId: name } }],
      toolCalls: [{ toolCallId: `${base}_0`, name, argumentsJson: { q: `lookup-${base}` } }],
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function toolResultAtom(
  turnNumber: number,
  base: string,
  name: string,
  summary?: string,
): AiMessageAtomV1 {
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: name,
    status: 'SUCCEEDED',
    outputRef: `output.${base}_0/content`,
    summary: summary ?? `rows for ${name}`,
  };
  return {
    schemaVersion: 1,
    atomId: `res-${base}`,
    role: 'tool',
    sourceId: `${base}_0`,
    sourceKind: 'tool_result',
    message: toolResultMessage(envelope),
    createdAtMs: turnNumber * 1000 + 1,
    turnNumber,
  };
}

function restoreAtom(turnNumber: number, n = 1): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `restore-${String(n)}`,
    role: 'system',
    sourceId: `compaction:${String(n)}`,
    sourceKind: 'compaction_restore',
    message: textMessage('system', `## Conversation Compressed (summary #${String(n)})`),
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function clearedSummaryAtom(turnNumber: number, n: number): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `cleared-${String(n)}`,
    role: 'system',
    sourceId: `cleared:exchange:s${String(n)}`,
    sourceKind: 'cleared_summary',
    message: textMessage('system', `[Cleared exchange — 1 tool call] • memory.store.query(...)`),
    createdAtMs: turnNumber * 1000 + 2,
    turnNumber,
  };
}

function atomRefsFor(atoms: AiMessageAtomV1[], ref: string) {
  return atoms.map((a) => ({
    atomId: a.atomId,
    ref,
    role: a.role,
    sourceKind: a.sourceKind,
    hash: 'h',
    createdAtMs: a.createdAtMs,
    ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
  }));
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
      atoms: atomRefsFor(atoms, batchRef),
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
  const assembled = await store.assembleRequest('sys', []);
  return { store, storeFn, state, assembled };
}

/** Production sanitization pipeline, in the load-bearing order (agentTurnRequest.ts). */
function sanitizeToChat(messages: ChatMessage[]): ChatMessage[] {
  return enforceToolResultAdjacency(convertOrphanToolMessages(mergeConsecutiveMessages(messages)));
}

// ============================================================================
// §4.1 — pin predicate
// ============================================================================

describe('computePinnedAtomIds (§4.1)', () => {
  it('pins all turn-0 user_input atoms', () => {
    const atoms = [
      userAtom(0, 'a'),
      { ...userAtom(0, 'b'), atomId: 'user-0b' },
      userAtom(3),
      userAtom(4),
    ];
    const pinned = computePinnedAtomIds(atoms, 5);
    expect(pinned.has('user-0')).toBe(true);
    expect(pinned.has('user-0b')).toBe(true);
    expect(pinned.has('user-3')).toBe(false);
  });

  it('pins the first user_input when turn numbers are absent', () => {
    const a = { ...userAtom(1), atomId: 'first-user' } as AiMessageAtomV1;
    delete (a as { turnNumber?: number }).turnNumber;
    const b = { ...userAtom(2), atomId: 'second-user' } as AiMessageAtomV1;
    delete (b as { turnNumber?: number }).turnNumber;
    const c = { ...userAtom(3), atomId: 'third-user' } as AiMessageAtomV1;
    delete (c as { turnNumber?: number }).turnNumber;
    const pinned = computePinnedAtomIds([a, b, c]);
    expect(pinned.has('first-user')).toBe(true);
    expect(pinned.has('second-user')).toBe(false);
  });

  it('pins the latest user_input — the request the current run answers', () => {
    const pinned = computePinnedAtomIds(
      [userAtom(0), userAtom(4), assistantTextAtom(5), userAtom(9), assistantTextAtom(10)],
      20,
    );
    expect(pinned.has('user-0')).toBe(true);
    expect(pinned.has('user-4')).toBe(false);
    expect(pinned.has('user-9')).toBe(true);
  });

  it('pins only the LATEST compaction_restore atom', () => {
    const pinned = computePinnedAtomIds([userAtom(0), restoreAtom(2, 1), restoreAtom(8, 2)], 20);
    expect(pinned.has('restore-2')).toBe(true);
    expect(pinned.has('restore-1')).toBe(false);
  });

  it('pins every atom of the current turn', () => {
    const pinned = computePinnedAtomIds(
      [userAtom(0), assistantTextAtom(6), assistantTextAtom(7)],
      7,
    );
    expect(pinned.has('asst-text-7')).toBe(true);
    expect(pinned.has('asst-text-6')).toBe(false);
  });
});

// ============================================================================
// §4.7 — no silent splice; forced clearing never evicts pinned atoms
// ============================================================================

describe('Tier-4 safety bound (§4.7)', () => {
  function threeHundredAtoms(): AiMessageAtomV1[] {
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION), restoreAtom(10)];
    for (let t = 1; t <= 149; t++) {
      const base = `ex${String(t).padStart(3, '0')}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(toolResultAtom(t, base, 'memory.store.query'));
    }
    return atoms;
  }

  it('assembleRequest hydrates EVERY atom — the FIFO splice is gone', async () => {
    const atoms = threeHundredAtoms();
    expect(atoms).toHaveLength(300);
    const { assembled } = await makeStoreAndAssemble(atoms, 150);
    // 1 system message + all 300 history atoms — nothing silently dropped.
    expect(assembled.messages).toHaveLength(301);
    const texts = assembled.messages.flatMap((m) =>
      m.parts.map((p) => (p.kind === 'text' ? p.text : '')),
    );
    expect(texts.some((t) => t.includes(OPENING_INSTRUCTION))).toBe(true);
  });

  it('storeTurn never evicts atoms (no windowing splice)', async () => {
    const atoms = threeHundredAtoms();
    const { store } = await makeStoreAndAssemble(atoms, 150);
    store.setTurnNumber(150);
    store.recordAssistantResponse({ action: 'complete', message: 'done' }, 150);
    const before = new Set(store.getState().history.atoms.map((a) => a.atomId));
    await store.storeTurn();
    const after = store.getState().history.atoms.map((a) => a.atomId);
    expect(after).toHaveLength(301);
    for (const id of before) expect(after).toContain(id);
  });

  /**
   * A finished run of large-result exchanges at turns 1..n, then the request
   * that starts the current run at turn n+1. The conversation is at turn n+2.
   */
  function finishedRunAtoms(n: number): AiMessageAtomV1[] {
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION), restoreAtom(10)];
    for (let t = 1; t <= n; t++) {
      const base = `ex${String(t).padStart(3, '0')}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(toolResultAtom(t, base, 'memory.store.query', 'x'.repeat(9000)));
    }
    atoms.push(userAtom(n + 1, 'next request'));
    return atoms;
  }

  it('never evicts pinned atoms under maximal hard-budget pressure, and breaches the recency floor', async () => {
    const atoms = finishedRunAtoms(149);
    const { store, storeFn } = await makeStoreAndAssemble(atoms, 151);
    const beforeIds = new Set(store.getState().history.atoms.map((a) => a.atomId));

    // Demand more than is clearable — every unpinned exchange must go.
    const result = await store.forceClearExcess({
      excessTokens: 100_000_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(result).toBeDefined();
    // The hard-budget pass is the one path the recency floor does not bind
    // (§4.7), so exchanges 143..149 inside it go too.
    const clearable = 149;
    expect(151 - RETENTION_POLICY.keepRecentTurns - 1).toBeLessThan(clearable);
    expect(result!.clearedExchangeCount).toBe(clearable);
    expect(result!.atomsSummarized).toBe(clearable * 2);

    const after = store.getState().history.atoms;
    const afterIds = new Set(after.map((a) => a.atomId));
    // Pinned anchors survive: the opening instruction, the latest restore atom
    // and the request of the current run.
    expect(afterIds.has('user-0')).toBe(true);
    expect(afterIds.has('restore-1')).toBe(true);
    expect(afterIds.has('user-150')).toBe(true);
    // One in-position note per cleared exchange.
    expect(after.filter((a) => a.sourceKind === 'cleared_summary')).toHaveLength(clearable);

    // Guard: every removed atom is archived — removal always leaves a trace.
    const archiveCall = storeFn.mock.calls.find(
      (c) => (c[0] as { stepExecutionId: string }).stepExecutionId === 'step-exec-uuid-archive-0',
    );
    expect(archiveCall).toBeDefined();
    const archivedIds = new Set(
      (archiveCall![0] as { data: Array<{ atomId: string }> }).data.map((a) => a.atomId),
    );
    const removed = [...beforeIds].filter((id) => !afterIds.has(id));
    expect(removed).toHaveLength(clearable * 2);
    for (const id of removed) expect(archivedIds.has(id)).toBe(true);
  });

  it('never clears an exchange because the atom count is over the cap', async () => {
    const atoms = finishedRunAtoms(149);
    const { store } = await makeStoreAndAssemble(atoms, 151);
    expect(store.structuralAtomExcess()).toBeGreaterThan(0);

    const result = await store.forceClearExcess({
      excessTokens: 0,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(result).toBeUndefined();
    expect(store.getState().history.atoms).toHaveLength(atoms.length);
  });

  it('token-bound forced clearing stops once estimated savings cover the deficit', async () => {
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION)];
    for (let t = 1; t <= 8; t++) {
      const base = `tok${String(t)}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(toolResultAtom(t, base, 'memory.store.query', 'x'.repeat(9000)));
    }
    atoms.push(userAtom(9, 'next request'));
    const { store } = await makeStoreAndAssemble(atoms, 20);
    const result = await store.forceClearExcess({
      excessTokens: 500,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(result!.clearedExchangeCount).toBe(1);
    expect(result!.estimatedTokensFreed).toBeGreaterThanOrEqual(500);
    const afterIds = new Set(store.getState().history.atoms.map((a) => a.atomId));
    expect(afterIds.has('asst-tok1')).toBe(false);
    expect(afterIds.has('asst-tok2')).toBe(true);
  });

  it('forced shedding fails CLOSED when the archive write fails', async () => {
    const atoms = finishedRunAtoms(149);
    const retrieve = vi.fn().mockResolvedValue(atoms);
    const storeFn = vi.fn().mockImplementation((params: { stepExecutionId: string }) => {
      if (params.stepExecutionId.includes('-archive-')) {
        return Promise.reject(new Error('gcs unavailable'));
      }
      return Promise.resolve('ref:new');
    });
    const store = new ConversationStateStore(
      { ...baseConfig, payloadStore: { retrieve, store: storeFn } as unknown as PayloadStore },
      makeState(atoms, 151),
    );
    await store.assembleRequest('sys', []);
    const before = store.getState().history.atoms.length;
    await expect(
      store.forceClearExcess({
        excessTokens: 10_000,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      }),
    ).rejects.toThrow('gcs unavailable');
    // The archive write fails BEFORE any state mutation — nothing was dropped.
    expect(store.getState().history.atoms).toHaveLength(before);
  });
});

// ============================================================================
// §4.7 — a text-heavy over-cap history reaches the structural_cap compaction trigger
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

function mockClient(): AIClient {
  return {
    contextWindowFor: () => undefined,

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
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
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

describe('handleAgentTurn Tier-4 ladder (§4.7)', () => {
  it('text-heavy over-cap history reaches the structural_cap compaction trigger, not a drop', async () => {
    const mem = createMemoryPayloadStore();
    // 210 text atoms, turns 0..209 — no tool exchanges, nothing for Tier-2.
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION)];
    for (let t = 1; t <= 209; t++) {
      atoms.push(t % 2 === 0 ? userAtom(t, `note ${String(t)}`) : assistantTextAtom(t));
    }
    const stateRef = await seedConversation(mem, atoms, 210);
    const initialIds = new Set(atoms.map((a) => a.atomId));

    const writes: Array<{ kind: string; data: unknown }> = [];
    const ctx = makeCtx(writes);
    const client = mockClient();
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
      baseAgentInput({ conversationStateRef: stateRef, turnNumber: 210 }),
      deps,
    );
    expect(result.status).toBe('SUCCEEDED');

    const output = writes.find((w) => w.kind === 'output')?.data as {
      conversationStateRef?: string;
      contextEngineering?: { compaction?: { compactionNumber: number } };
    };
    expect(output.conversationStateRef).toBeDefined();
    expect(output.contextEngineering?.compaction).toBeDefined();
    expect(ctx.log.info).toHaveBeenCalledWith(
      'agent_turn_compaction',
      expect.objectContaining({ trigger: 'structural_cap' }),
    );

    const finalState = (await mem.retrieve(
      output.conversationStateRef as never,
    )) as AiConversationStateV1;
    const finalIds = new Set(finalState.history.atoms.map((a) => a.atomId));

    // Bound relieved through compaction — never a drop.
    expect(finalState.history.atoms.length).toBeLessThanOrEqual(
      RETENTION_POLICY.maxAtomsStructural,
    );
    const restoreRef = finalState.history.atoms.find((a) => a.sourceKind === 'compaction_restore');
    expect(restoreRef).toBeDefined();
    expect(restoreRef!.role).toBe('user');
    const restoreBatch = (await mem.retrieve(restoreRef!.ref as never)) as AiMessageAtomV1[];
    const restoreText = restoreBatch
      .find((a) => a.atomId === restoreRef!.atomId)!
      .message.parts.map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');
    expect(restoreText).toMatch(
      /^\[Context note — conversation history before turn \d+ was compressed; summary follows/,
    );
    expect(restoreText).not.toContain('You are now on turn');
    // The opening instruction is pinned and survives.
    expect(finalIds.has('user-0')).toBe(true);

    // Guard: every removed atom is in the compaction archive (replacement +
    // trace, no silent removal).
    const artifact = (await mem.retrieve(
      finalState.compaction!.artifactRef as never,
    )) as CompactionArtifact;
    const archived = (await mem.retrieve(artifact.rawAtomsRef as never)) as AiMessageAtomV1[];
    const archivedIds = new Set(archived.map((a) => a.atomId));
    for (const id of initialIds) {
      if (!finalIds.has(id)) expect(archivedIds.has(id)).toBe(true);
    }
  });

  it('forced shedding failure fails the step closed (retryable)', async () => {
    const mem = createMemoryPayloadStore();
    const failingStore: PayloadStore = {
      ...mem,
      store: (params) =>
        params.stepExecutionId.includes('-archive-')
          ? Promise.reject(new Error('gcs unavailable'))
          : mem.store(params),
    };
    // A finished run of large results and a prompt over the hard budget. The
    // summarizer is down, so compaction (best-effort) relieves nothing, and
    // both opportunistic clearing (best-effort, swallowed) and forced clearing
    // (fail-closed) hit the failing archive write.
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION)];
    for (let t = 1; t <= 110; t++) {
      const base = `fx${String(t).padStart(3, '0')}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(toolResultAtom(t, base, 'memory.store.query', 'x'.repeat(9000)));
    }
    atoms.push(userAtom(111, 'next request'));
    const stateRef = await seedConversation(failingStore, atoms, 112);

    const writes: Array<{ kind: string; data: unknown }> = [];
    const ctx = makeCtx(writes);
    const client = mockClient();
    vi.mocked(client.generateJson).mockResolvedValue({
      data: { action: 'pause_for_input', message: 'ok' },
      rawContent: '{"action":"pause_for_input","message":"ok"}',
      model: 'test-model',
      provider: 'openai',
      usage: { promptTokens: 400_000, completionTokens: 5, totalTokens: 400_005 },
    } as never);
    vi.mocked(client.generateText).mockRejectedValue(new Error('summarizer unavailable'));
    vi.mocked(getAIClientForContext).mockResolvedValue(client);
    const deps: HandlerDeps = {
      payloadStore: failingStore,
      handleError: vi.fn().mockImplementation((_c, _l, e: unknown) => {
        throw e;
      }),
      validateToolArgs: () => null,
    };

    const result = await handleAgentTurn(
      ctx,
      baseAgentInput({ conversationStateRef: stateRef, turnNumber: 112 }),
      deps,
    );
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('Forced history shedding failed');
    }
  });
});

// ============================================================================
// Founding incident (run e4c5061e) — the opening instruction never evicts and
// the wire-layer user bridge never fires
// ============================================================================

describe('founding incident shape — pinned opener, bridge never fires', () => {
  it('keeps the opening instruction in every assembled request across turns', async () => {
    const mem = createMemoryPayloadStore();
    // 124 atoms: well past the old 50-atom window that evicted the opener.
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION)];
    for (let t = 1; t <= 60; t++) {
      const base = `mb${String(t).padStart(3, '0')}`;
      atoms.push(
        assistantToolAtom(t, base, t % 3 === 0 ? 'compute.sandbox.exec' : 'memory.store.query'),
      );
      atoms.push(
        toolResultAtom(t, base, t % 3 === 0 ? 'compute.sandbox.exec' : 'memory.store.query'),
      );
    }
    atoms.push(clearedSummaryAtom(30, 1));
    atoms.push(clearedSummaryAtom(31, 2));
    atoms.push(clearedSummaryAtom(32, 3));

    let stateRef = await seedConversation(mem, atoms, 61);

    for (let turn = 61; turn <= 63; turn++) {
      const store = await ConversationStateStore.loadOrCreate(
        {
          payloadStore: mem,
          tenantId: 'tenant-test',
          runId: 'run-test',
          stepId: 'agent-1',
          stepExecutionId: `exec-${String(turn)}`,
          attempt: 1,
        },
        stateRef,
      );
      // The structural cap is applied at load (clean cut over persisted state).
      expect(store.getState().history.maxAtomsStructural).toBe(RETENTION_POLICY.maxAtomsStructural);
      store.setTurnNumber(turn);
      const assembled = await store.assembleRequest('agent instructions', []);

      const chat = assembled.messages.map(aiMessageToChatMessage);
      const sanitized = sanitizeToChat(chat);

      const { contents } = toGeminiContents(sanitized, { nativeFunctionCalling: true });
      expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);
      // The opening instruction leads the conversation…
      expect(contents[0]!.role).toBe('user');
      expect(
        contents[0]!.parts?.some(
          (p) => 'text' in p && typeof p.text === 'string' && p.text.includes(OPENING_INSTRUCTION),
        ),
      ).toBe(true);
      // …and the truncated-history bridge never fires.
      const geminiTexts = contents.flatMap((c) =>
        (c.parts ?? []).map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')),
      );
      expect(geminiTexts).not.toContain(TRUNCATED_HISTORY_USER_BRIDGE_TEXT);

      const { messages: anthropicMessages } = toAnthropicMessages(sanitized);
      expect(checkAnthropicMessagesWireValidity(anthropicMessages).issues).toEqual([]);
      expect(anthropicMessages[0]!.role).toBe('user');
      expect(JSON.stringify(anthropicMessages[0]!.content)).toContain(OPENING_INSTRUCTION);
      expect(JSON.stringify(anthropicMessages)).not.toContain(TRUNCATED_HISTORY_USER_BRIDGE_TEXT);

      store.recordAssistantResponse({ action: 'complete', message: `done ${String(turn)}` }, turn);
      const turnResult = await store.storeTurn();
      stateRef = turnResult.conversationStateRef;
    }
  });
});

// ============================================================================
// §4.7 backstop signal — a fired wire bridge logs as a policy-bug signal
// ============================================================================

describe('logWireBridgeIfFiring (§4.7 backstop signal, both model paths)', () => {
  it('warns agent_turn_wire_bridge_fired when the first non-system message is an assistant turn', () => {
    const ctx = makeCtx([]);
    logWireBridgeIfFiring(
      ctx,
      { turnNumber: 7 },
      [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'orphaned opener' },
      ],
      'test-model',
      'google',
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'agent_turn_wire_bridge_fired',
      expect.objectContaining({ turnNumber: 7, model: 'test-model', provider: 'google' }),
    );
  });

  it('stays silent when the history opens on a user message', () => {
    const ctx = makeCtx([]);
    logWireBridgeIfFiring(
      ctx,
      { turnNumber: 7 },
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: OPENING_INSTRUCTION },
        { role: 'assistant', content: 'ok' },
      ],
      'test-model',
      'google',
    );
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Same-turn Tier-2 + Tier-4 passes — payload keys are unique per clearing cycle
// ============================================================================

describe('same-turn Tier-2 + Tier-4 clearing (payload-key isolation)', () => {
  it('keeps both passes hydratable — the second pass never overwrites the first batch', async () => {
    const mem = createMemoryPayloadStore();
    const atoms: AiMessageAtomV1[] = [userAtom(0, OPENING_INSTRUCTION)];
    for (let t = 1; t <= 12; t++) {
      const base = `dx${String(t).padStart(2, '0')}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(toolResultAtom(t, base, 'memory.store.query', 'x'.repeat(9000)));
    }
    atoms.push(userAtom(13, 'next request'));
    const stateRef = await seedConversation(mem, atoms, 23);

    const store = await ConversationStateStore.loadOrCreate(
      {
        payloadStore: mem,
        tenantId: 'tenant-test',
        runId: 'run-test',
        stepId: 'agent-1',
        stepExecutionId: 'exec-23',
        attempt: 1,
      },
      stateRef,
    );
    store.setTurnNumber(23);
    await store.assembleRequest('sys', []);

    const tier2 = await store.clearUnderPressure({
      pressureTokens: 6_500,
      workingBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(tier2!.clearedExchangeCount).toBeGreaterThan(0);

    const tier4 = await store.forceClearExcess({
      excessTokens: 4_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(tier4!.clearedExchangeCount).toBeGreaterThan(0);

    // Each clearing cycle owns its payload keys — distinct archive + note batches.
    const ranges = store.getState().clearing!.ranges;
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.rawAtomsRef).not.toBe(ranges[1]!.rawAtomsRef);
    const noteRefs = new Set(
      store
        .getState()
        .history.atoms.filter((a) => a.sourceKind === 'cleared_summary')
        .map((a) => a.ref),
    );
    expect(noteRefs.size).toBe(2);

    // Next turn hydrates every note from BOTH passes — no dangling atom refs.
    const next = await ConversationStateStore.loadOrCreate(
      {
        payloadStore: mem,
        tenantId: 'tenant-test',
        runId: 'run-test',
        stepId: 'agent-1',
        stepExecutionId: 'exec-14',
        attempt: 1,
      },
      tier4!.conversationStateRef,
    );
    const assembled = await next.assembleRequest('sys', []);
    const noteMessages = assembled.messages.filter((m) =>
      m.parts.some((p) => p.kind === 'text' && p.text.startsWith('[Context note —')),
    );
    expect(noteMessages).toHaveLength(tier2!.clearedExchangeCount + tier4!.clearedExchangeCount);
  });
});
