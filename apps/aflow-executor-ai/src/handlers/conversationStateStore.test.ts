import { describe, it, expect, vi } from 'vitest';
import type {
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
} from '@aflow/schemas';
import {
  textMessage,
  toolResultMessage,
  AiConversationStateV1Schema,
  MEMORY_READ_OPERATION_ID,
} from '@aflow/schemas';
import { ConversationStateStore } from './conversationStateStore.js';
import { ConversationHistoryHydrationError } from './historyHydrationError.js';

describe('ConversationStateStore.assembleRequest', () => {
  const baseConfig = {
    payloadStore: {
      retrieve: vi.fn(),
      store: vi.fn(),
    },
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepId: 'agent',
    stepExecutionId: 'step-exec-uuid',
    attempt: 1,
  };

  function makeState(overrides: Partial<AiConversationStateV1> = {}): AiConversationStateV1 {
    return {
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 0,
      context: {},
      history: { atoms: [], maxAtomsStructural: 200 },
      seenSourceIds: {},
      ...overrides,
    };
  }

  it('counts only the non-volatile tiers it actually emitted', async () => {
    const store = new ConversationStateStore({ ...baseConfig }, makeState());

    // All three tiers: prompt + stable + run_stable = 3 cacheable.
    const all = await store.assembleRequest('system text', [
      { key: 'SpaceContext', content: { slug: 'desk' } },
      { key: 'FlowRunContext', content: { runId: 'r1' }, cacheHint: 'run_stable' },
      { key: 'Attention', content: 'x', cacheHint: 'volatile' },
    ]);
    expect(all.cacheableSystemBlockCount).toBe(3);

    // A run with no space context but a loop warning ships
    // [prompt, run_stable, volatile]. A fixed 3 would mark the volatile tail:
    // a cache write every turn against a block that never repeats.
    const noSpace = await store.assembleRequest('system text', [
      { key: 'FlowRunContext', content: { runId: 'r1' }, cacheHint: 'run_stable' },
      { key: 'LoopWarning', content: 'careful', cacheHint: 'volatile' },
    ]);
    expect(noSpace.cacheableSystemBlockCount).toBe(2);

    // Volatile only: nothing but the prompt is worth a breakpoint.
    const volatileOnly = await store.assembleRequest('system text', [
      { key: 'Attention', content: 'x', cacheHint: 'volatile' },
    ]);
    expect(volatileOnly.cacheableSystemBlockCount).toBe(1);

    // No context blocks at all.
    const bare = await store.assembleRequest('system text', []);
    expect(bare.cacheableSystemBlockCount).toBe(1);
  });

  it('ships the three cache tiers as separate system messages, longest-lived first', async () => {
    const store = new ConversationStateStore({ ...baseConfig }, makeState());
    const { messages } = await store.assembleRequest('system text', [
      { key: 'FlowRunContext', content: { runId: 'r1' }, cacheHint: 'run_stable' },
      { key: 'SpaceContext', content: { slug: 'desk' } },
      { key: 'HelmsmanAttention', content: 'No active runs.', cacheHint: 'volatile' },
    ]);

    const systemTexts = messages
      .filter((m) => m.role === 'system')
      .map((m) => {
        const part = m.parts?.find((p) => p.kind === 'text');
        return part?.kind === 'text' ? part.text : '';
      });

    // [0] prompt, [1] space-stable, [2] run-stable, [3] volatile.
    expect(systemTexts).toHaveLength(4);
    expect(systemTexts[0]).toBe('system text');
    expect(systemTexts[1]).toContain('### SpaceContext');
    expect(systemTexts[2]).toContain('### FlowRunContext');
    expect(systemTexts[3]).toContain('### HelmsmanAttention');

    // `runId` must not share a block with SpaceContext: Anthropic marks
    // cache_control per system block, so co-locating them would invalidate the
    // space's context on every new run.
    expect(systemTexts[1]).not.toContain('runId');
  });

  it('emits only the tiers that have blocks, and heads the first one', async () => {
    const store = new ConversationStateStore({ ...baseConfig }, makeState());
    const { messages } = await store.assembleRequest('system text', [
      { key: 'HelmsmanAttention', content: 'Nothing pending.', cacheHint: 'volatile' },
    ]);
    const systemTexts = messages
      .filter((m) => m.role === 'system')
      .map((m) => {
        const part = m.parts?.find((p) => p.kind === 'text');
        return part?.kind === 'text' ? part.text : '';
      });
    expect(systemTexts).toHaveLength(2);
    expect(systemTexts[1]?.startsWith('## Context\n')).toBe(true);
  });

  it('serializes object context blocks compactly — the model is the only reader', async () => {
    const store = new ConversationStateStore({ ...baseConfig }, makeState());
    const { messages } = await store.assembleRequest('system text', [
      { key: 'SpaceContext', content: { space: { slug: 'desk', name: 'Desk' } } },
    ]);

    const contextMessage = messages.find((m) =>
      m.parts?.some((p) => p.kind === 'text' && p.text.includes('### SpaceContext')),
    );
    const text = contextMessage?.parts?.find((p) => p.kind === 'text');
    const rendered = text?.kind === 'text' ? text.text : '';

    expect(rendered).toContain('{"space":{"slug":"desk","name":"Desk"}}');
    // Pretty printing this block costs ~1,281 chars of indentation on a real
    // SpaceContext and buys nothing any reader wants.
    expect(rendered).not.toContain('\n  "space"');
  });

  it('leaves string context blocks untouched', async () => {
    const store = new ConversationStateStore({ ...baseConfig }, makeState());
    const { messages } = await store.assembleRequest('system text', [
      { key: 'HelmsmanAttention', content: 'No active workflow runs.', cacheHint: 'volatile' },
    ]);
    const rendered = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.kind === 'text')
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('\n');
    expect(rendered).toContain('### HelmsmanAttention\nNo active workflow runs.');
  });

  it('names each unreadable batch, the turn it was committed at, and why it could not be read', async () => {
    const retrieve = vi.fn((ref: string) =>
      ref === 'payload:history:bad'
        ? Promise.reject(new Error('Payload not found: payload:history:bad'))
        : Promise.resolve([
            {
              schemaVersion: 1,
              atomId: 'atom-3',
              role: 'user',
              sourceId: 's3',
              sourceKind: 'user_input',
              message: textMessage('user', 'still here'),
              createdAtMs: 3,
              turnNumber: 40,
            },
          ]),
    );
    const store = new ConversationStateStore(
      { ...baseConfig, payloadStore: { ...baseConfig.payloadStore, retrieve } },
      makeState({
        turnNumber: 82,
        history: {
          maxAtomsStructural: 200,
          atoms: [
            {
              atomId: 'atom-1',
              ref: 'payload:history:bad',
              role: 'user',
              hash: 'x',
              createdAtMs: 1,
              turnNumber: 13,
            },
            {
              atomId: 'atom-2',
              ref: 'payload:history:bad',
              role: 'assistant',
              hash: 'y',
              createdAtMs: 2,
              turnNumber: 12,
            },
            {
              atomId: 'atom-3',
              ref: 'payload:history:good',
              role: 'user',
              hash: 'z',
              createdAtMs: 3,
              turnNumber: 40,
            },
          ],
        },
      }),
    );

    const failure = store.assembleRequest('system text', []);
    await expect(failure).rejects.toMatchObject({
      name: 'ConversationHistoryHydrationError',
      failedBatches: [
        {
          ref: 'payload:history:bad',
          committedAtTurn: 12,
          readError: 'Payload not found: payload:history:bad',
        },
      ],
    });
    await expect(failure).rejects.toThrow(
      'payload:history:bad (committed at turn 12: Payload not found: payload:history:bad)',
    );
    await expect(failure).rejects.toThrow('could not be hydrated at turn 82');
  });

  it('throws when batch loads but the committed atomId is missing from the batch', async () => {
    const atomInBatch: AiMessageAtomV1 = {
      schemaVersion: 1,
      atomId: 'other-atom',
      role: 'user',
      sourceId: 's',
      sourceKind: 'user_input',
      message: textMessage('user', 'hi'),
      createdAtMs: 1,
    };
    const retrieve = vi.fn().mockResolvedValue([atomInBatch]);
    const store = new ConversationStateStore(
      { ...baseConfig, payloadStore: { ...baseConfig.payloadStore, retrieve } },
      makeState({
        history: {
          maxAtomsStructural: 200,
          atoms: [
            {
              atomId: 'missing-atom',
              ref: 'payload:history:batch',
              role: 'user',
              hash: 'x',
              createdAtMs: 1,
            },
          ],
        },
      }),
    );

    await expect(store.assembleRequest('sys', [])).rejects.toThrow(
      ConversationHistoryHydrationError,
    );
  });
});

// ============================================================================

describe('ConversationStateStore.clearUnderPressure (Plan 189 §5 / Plan 196 §4.3)', () => {
  const baseConfig = {
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepId: 'agent',
    stepExecutionId: 'step-exec-uuid',
    attempt: 1,
  };

  const S1 = 'a'.repeat(32); // compact-id base for a parallel exchange

  function assistantAtom(turnNumber: number, base: string, names: string[]): AiMessageAtomV1 {
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
          argumentsJson: { which: i, q: `lookup-${String(i)}` },
        })),
      },
      createdAtMs: turnNumber * 1000,
      turnNumber,
    };
  }

  function toolResultAtom(
    turnNumber: number,
    base: string,
    i: number,
    toolName: string,
  ): AiMessageAtomV1 {
    const envelope: AiToolResultEnvelopeV1 = {
      kind: 'tool_result',
      toolCallId: `${base}_${String(i)}`,
      toolName,
      status: 'SUCCEEDED',
      outputRef: `output.${base}_${String(i)}/content`,
      // Large enough that clearing nets more than the §4.3 minClearNetSavings bar.
      summary: `rows for ${toolName}#${String(i)} ` + 'x'.repeat(2000),
    };
    return {
      schemaVersion: 1,
      atomId: `res-${base}-${String(i)}`,
      role: 'tool',
      sourceId: `${base}_${String(i)}`,
      sourceKind: 'tool_result',
      message: toolResultMessage(envelope),
      createdAtMs: turnNumber * 1000 + i,
      turnNumber,
    };
  }

  function userAtom(turnNumber: number): AiMessageAtomV1 {
    return {
      schemaVersion: 1,
      atomId: `user-${String(turnNumber)}`,
      role: 'user',
      sourceId: `u${String(turnNumber)}`,
      sourceKind: 'user_input',
      message: textMessage('user', 'go'),
      createdAtMs: turnNumber * 1000,
      turnNumber,
    };
  }

  async function makeStoreAndAssemble(fullAtoms: AiMessageAtomV1[], turnNumber: number) {
    const retrieve = vi.fn().mockResolvedValue(fullAtoms);
    const storeFn = vi.fn().mockResolvedValue('ref:new');
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber,
      context: {},
      seenSourceIds: {},
      history: {
        maxAtomsStructural: 200,
        atoms: fullAtoms.map((a) => ({
          atomId: a.atomId,
          ref: 'batch:1',
          role: a.role,
          sourceKind: a.sourceKind,
          hash: 'h',
          createdAtMs: a.createdAtMs,
          ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
        })),
      },
    };
    const store = new ConversationStateStore(
      { ...baseConfig, payloadStore: { retrieve, store: storeFn } },
      state,
    );
    // Populate lastHydratedAtoms (clearing reads assistant toolCalls + envelopes from it).
    await store.assembleRequest('sys', []);
    return { store, storeFn, state };
  }

  // Over-pressure input: 0.9 utilization against a 10k budget — well above
  // clearHighWater, so the only gates left are recency/pinning/net-savings.
  const overPressure = {
    pressureTokens: 9_000,
    effectiveBudget: 10_000,
    availableReadOpId: MEMORY_READ_OPERATION_ID,
  };

  // Parallel exchange: assistant fires two calls (turn 1); its two results land
  // in turns 2 and 3 — the exchange spans turns 1..3.
  function parallelExchangeAtoms(): AiMessageAtomV1[] {
    return [
      userAtom(0),
      assistantAtom(1, S1, ['memory.store.query', 'memory.store.query']),
      toolResultAtom(2, S1, 0, 'memory.store.query'),
      toolResultAtom(3, S1, 1, 'memory.store.query'),
    ];
  }

  it('does NOT clear an exchange while any of its turns is still recent', async () => {
    // currentTurn=4: result at turn 3 is within keepRecentTurns(3) → retain whole exchange.
    const { store } = await makeStoreAndAssemble(parallelExchangeAtoms(), 4);
    const result = await store.clearUnderPressure(overPressure);
    expect(result).toBeUndefined();
    // Nothing removed — the tool_use atom and both results survive together.
    const kinds = store.getState().history.atoms.map((a) => a.sourceKind);
    expect(kinds.filter((k) => k === 'assistant_turn')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'tool_result')).toHaveLength(2);
  });

  it('clears the assistant + all results together once the whole exchange is past recency', async () => {
    // currentTurn=7: every turn (1..3) is past the recency guard → clear the exchange.
    const { store, storeFn } = await makeStoreAndAssemble(parallelExchangeAtoms(), 7);
    const result = await store.clearUnderPressure(overPressure);

    expect(result).toMatchObject({ clearedExchangeCount: 1, atomsSummarized: 3 });

    const atoms = store.getState().history.atoms;
    // The exchange is gone; exactly one cleared_summary replaces it. The user
    // atom (turn 0, standalone) survives.
    expect(atoms.filter((a) => a.sourceKind === 'assistant_turn')).toHaveLength(0);
    expect(atoms.filter((a) => a.sourceKind === 'tool_result')).toHaveLength(0);
    expect(atoms.filter((a) => a.sourceKind === 'cleared_summary')).toHaveLength(1);
    expect(atoms.filter((a) => a.sourceKind === 'user_input')).toHaveLength(1);

    // No atom list ever carries a tool_use base without its results (or vice
    // versa): after clearing, neither survives — they left as one unit.
    const summaryAtom = atoms.find((a) => a.sourceKind === 'cleared_summary')!;
    expect(summaryAtom.turnNumber).toBe(1); // placed at the assistant's slot
    expect(summaryAtom.role).toBe('user'); // §4.5 in-position user-role note

    // clearing state records the exchange key for idempotency.
    const clearing = store.getState().clearing;
    expect(clearing?.clearedExchanges).toContain(S1);
    expect(clearing?.ranges).toHaveLength(1);

    // archive + summary batches were stored under synthetic step-exec suffixes.
    const clearCall = storeFn.mock.calls.find(
      (c) => (c[0] as { stepExecutionId: string }).stepExecutionId === 'step-exec-uuid-clear-0',
    );
    expect(clearCall).toBeDefined();
  });

  it('summary captures each call intent — tool, compact id/index, args digest, status (§5.3)', async () => {
    const { store, storeFn } = await makeStoreAndAssemble(parallelExchangeAtoms(), 7);
    await store.clearUnderPressure(overPressure);

    const clearCall = storeFn.mock.calls.find(
      (c) => (c[0] as { stepExecutionId: string }).stepExecutionId === 'step-exec-uuid-clear-0',
    )!;
    const summaryAtoms = (clearCall[0] as { data: AiMessageAtomV1[] }).data;
    expect(summaryAtoms).toHaveLength(1);
    const text = summaryAtoms[0]!.message.parts
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');

    // Both calls named, with their compact ids, argument digests, and status.
    expect(text).toContain('memory.store.query');
    expect(text).toContain(`${S1}_0`);
    expect(text).toContain(`${S1}_1`);
    expect(text).toContain('lookup-0'); // argument digest, not just result status
    expect(text).toContain('lookup-1');
    expect(text).toContain('succeeded');
    // header names both calls
    expect(text).toContain('2 tool calls');
  });

  it('still clears a fully-aged single-call exchange (no regression, §5.5)', async () => {
    const atoms = [
      userAtom(0),
      assistantAtom(1, S1, ['compute.run']),
      toolResultAtom(2, S1, 0, 'compute.run'),
    ];
    const { store, storeFn } = await makeStoreAndAssemble(atoms, 7);
    const result = await store.clearUnderPressure(overPressure);
    expect(result).toMatchObject({ clearedExchangeCount: 1, atomsSummarized: 2 });

    const clearCall = storeFn.mock.calls.find(
      (c) => (c[0] as { stepExecutionId: string }).stepExecutionId === 'step-exec-uuid-clear-0',
    )!;
    const text = (clearCall[0] as { data: AiMessageAtomV1[] }).data[0]!.message.parts.map((p) =>
      p.kind === 'text' ? p.text : '',
    ).join('');
    expect(text).toContain('compute.run');
    expect(text).toContain('1 tool call');
  });

  it('does not re-clear an exchange already in clearedExchanges (idempotency)', async () => {
    const { store } = await makeStoreAndAssemble(parallelExchangeAtoms(), 7);
    // Pretend this exchange was already cleared in a prior cycle.
    store.getState().clearing = {
      ranges: [],
      clearedExchanges: [S1],
      clearedCalls: [],
      resurrectedExchanges: [],
    };
    const result = await store.clearUnderPressure(overPressure);
    expect(result).toBeUndefined();
  });

  it('never fires below clearHighWater, regardless of exchange age', async () => {
    // Same fully-aged history as the clearing cases — but pressure is low.
    const { store } = await makeStoreAndAssemble(parallelExchangeAtoms(), 7);
    const result = await store.clearUnderPressure({
      pressureTokens: 5_000,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(result).toBeUndefined();
    expect(
      store.getState().history.atoms.filter((a) => a.sourceKind === 'tool_result'),
    ).toHaveLength(2);
  });
});

// ============================================================================

describe('AiConversationStateV1Schema — clearing (Plan 189 §5.4)', () => {
  it('accepts a clearing field with ranges and cleared exchange keys', () => {
    const parsed = AiConversationStateV1Schema.safeParse({
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 5,
      context: {},
      history: { atoms: [], maxAtomsStructural: 200 },
      seenSourceIds: {},
      clearing: {
        ranges: [{ fromTurn: 1, toTurn: 3, rawAtomsRef: 'ref:archive', clearedAt: 123 }],
        clearedExchanges: ['a'.repeat(32)],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.clearing?.clearedExchanges).toEqual(['a'.repeat(32)]);
    }
  });
});
