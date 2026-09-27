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
import type { AIClient } from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import { triggerCompaction } from './compaction.js';
import { buildClearedExchangeNote, extractNoteReadPointers } from './exchangeClearing.js';
import { RETENTION_POLICY, computePinnedAtomIds } from './retentionPolicy.js';

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

function assistantToolAtom(turnNumber: number, base: string, name: string): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_steps' } }],
      toolCalls: [{ toolCallId: `${base}_0`, name, argumentsJson: { q: `lookup-${base}` } }],
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function resultAtom(
  turnNumber: number,
  base: string,
  opts: { toolName: string; operationId: string; summaryChars: number },
): AiMessageAtomV1 {
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: opts.toolName,
    operationId: opts.operationId,
    status: 'SUCCEEDED',
    outputPath: `/run/outputs/${base}_0`,
    summary: 'r'.repeat(opts.summaryChars),
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

function refOf(a: AiMessageAtomV1, ref: string) {
  return {
    atomId: a.atomId,
    ref,
    role: a.role,
    sourceKind: a.sourceKind,
    hash: 'h',
    createdAtMs: a.createdAtMs,
    ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
  };
}

function mockClient(): AIClient {
  return {
    generateText: vi.fn().mockResolvedValue({
      content: '## What Was Accomplished\n- compressed',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      model: 'flash-lite',
      provider: 'google',
    }),
  } as unknown as AIClient;
}

const TENANT = 'tenant-test' as TenantId;
const RUN = 'run-test' as SessionId;

async function storeBatch(
  mem: PayloadStore,
  stepExecutionId: string,
  atoms: AiMessageAtomV1[],
): Promise<string> {
  return await mem.store({
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: stepExecutionId as StepExecutionId,
    attempt: 1,
    kind: 'history',
    data: atoms,
  });
}

/** Hydrate full atoms for the committed list — what assembly would produce. */
async function hydrateFromState(
  mem: PayloadStore,
  state: AiConversationStateV1,
): Promise<AiMessageAtomV1[]> {
  const batches = new Map<string, AiMessageAtomV1[]>();
  for (const ref of new Set(state.history.atoms.map((a) => a.ref))) {
    batches.set(ref, (await mem.retrieve(ref as never)) as AiMessageAtomV1[]);
  }
  return state.history.atoms.map((r) => batches.get(r.ref)!.find((a) => a.atomId === r.atomId)!);
}

function restoreRefsOf(state: AiConversationStateV1) {
  return state.history.atoms.filter((a) => a.sourceKind === 'compaction_restore');
}

async function textOfAtomRef(
  mem: PayloadStore,
  ref: { atomId: string; ref: string },
): Promise<string> {
  const batch = (await mem.retrieve(ref.ref as never)) as AiMessageAtomV1[];
  return batch
    .find((a) => a.atomId === ref.atomId)!
    .message.parts.map((p) => (p.kind === 'text' ? p.text : ''))
    .join('\n');
}

// ============================================================================
// Note pointer render/parse round-trip (§4.8 sweep input)
// ============================================================================

describe('extractNoteReadPointers — round-trip with the note builder', () => {
  it('parses the pointer paths and tool names back out of a built note', () => {
    const asst = assistantToolAtom(2, 'cxA', 'memory.store.query');
    const res = resultAtom(2, 'cxA', {
      toolName: 'memory.store.query',
      operationId: 'memory.store.query',
      summaryChars: 500,
    });
    const hydratedById = new Map([
      [asst.atomId, asst],
      [res.atomId, res],
    ]);
    const ex = {
      atomRefs: [
        { atomId: asst.atomId, sourceKind: asst.sourceKind },
        { atomId: res.atomId, sourceKind: res.sourceKind },
      ],
      assistantAtom: asst,
    };
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(extractNoteReadPointers(note)).toEqual([
      { path: '/run/outputs/cxA_0/data', toolName: 'memory.store.query' },
    ]);
  });

  it('returns nothing for degraded notes without a read promise', () => {
    const asst = assistantToolAtom(2, 'cxB', 'memory.store.query');
    const res = resultAtom(2, 'cxB', {
      toolName: 'memory.store.query',
      operationId: 'memory.store.query',
      summaryChars: 500,
    });
    const hydratedById = new Map([
      [asst.atomId, asst],
      [res.atomId, res],
    ]);
    const ex = {
      atomRefs: [
        { atomId: asst.atomId, sourceKind: asst.sourceKind },
        { atomId: res.atomId, sourceKind: res.sourceKind },
      ],
      assistantAtom: asst,
    };
    const note = buildClearedExchangeNote(ex, hydratedById, { availableReadOpId: undefined });

    expect(extractNoteReadPointers(note)).toEqual([]);
  });
});

// ============================================================================
// Double compaction — pinned restore, pointers alive in activeRefs (§4.8)
// ============================================================================

describe('triggerCompaction — §4.8 alignment across a double compaction', () => {
  it('sweeps note pointers into activeRefs, pins the restore, and keeps both across a second compaction', async () => {
    const mem = createMemoryPayloadStore();

    // Turn 0 task, three big idempotent exchanges (turns 2-4), narrative
    // middle (5-14), recent tail (17-19). Current turn: 20.
    const atoms: AiMessageAtomV1[] = [userAtom(0)];
    for (let t = 2; t <= 4; t++) {
      const base = `cx${String(t)}`;
      atoms.push(assistantToolAtom(t, base, 'memory.store.query'));
      atoms.push(
        resultAtom(t, base, {
          toolName: 'memory.store.query',
          operationId: 'memory.store.query',
          summaryChars: 7_000,
        }),
      );
    }
    for (let t = 5; t <= 14; t++) {
      atoms.push(t % 2 === 0 ? userAtom(t, `note ${String(t)}`) : assistantTextAtom(t));
    }
    for (let t = 17; t <= 19; t++) {
      atoms.push(assistantTextAtom(t, `recent ${String(t)}`));
    }

    const seedRef = await storeBatch(mem, 'seed', atoms);
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 20,
      context: {},
      seenSourceIds: {},
      history: {
        maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
        atoms: atoms.map((a) => refOf(a, seedRef)),
      },
    };
    const store = new ConversationStateStore(
      {
        payloadStore: mem,
        tenantId: TENANT,
        runId: RUN,
        stepId: 'agent',
        stepExecutionId: 'exec-1',
        attempt: 1,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      },
      state,
    );
    await store.assembleRequest('sys', []);

    // Tier 2: clear the three exchanges to in-position notes with pointers.
    const cleared = await store.clearUnderPressure({
      pressureTokens: 9_500,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(cleared?.clearedExchangeCount).toBe(3);
    expect(state.history.atoms.filter((a) => a.sourceKind === 'cleared_summary')).toHaveLength(3);

    // Tier 3 #1 — mimic finishAgentTurn: hydrated atoms filtered to the state.
    const currentIds = new Set(state.history.atoms.map((a) => a.atomId));
    const hydrated1 = store.getHydratedAtoms().filter((a) => currentIds.has(a.atomId));
    const compact1 = await triggerCompaction(
      {
        payloadStore: mem,
        tenantId: TENANT,
        runId: RUN,
        stepId: 'agent',
        stepExecutionId: 'exec-1',
        attempt: 1,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      },
      state,
      hydrated1,
      undefined,
      mockClient(),
      'test-flow',
    );
    expect(compact1).toBeDefined();
    expect(compact1!.compactionNumber).toBe(1);

    // The notes were swept into the range — gone as atoms, folded into summary.
    expect(state.history.atoms.some((a) => a.sourceKind === 'cleared_summary')).toBe(false);

    // One in-position user-role restore note, structurally pinned.
    const restores1 = restoreRefsOf(state);
    expect(restores1).toHaveLength(1);
    expect(restores1[0]!.role).toBe('user');
    expect(computePinnedAtomIds(state.history.atoms, 19).has(restores1[0]!.atomId)).toBe(true);

    // The artifact's pinned state carries the swept pointers...
    const artifact1 = (await mem.retrieve(
      state.compaction!.artifactRef as never,
    )) as CompactionArtifact;
    const refs1 = (artifact1.pinnedState.activeRefs ?? []).map((r) => r.ref);
    expect(refs1).toEqual(
      expect.arrayContaining([
        '/run/outputs/cx2_0/data',
        '/run/outputs/cx3_0/data',
        '/run/outputs/cx4_0/data',
      ]),
    );
    // ...and the restore note renders them as read pointers, not bare $refs.
    const restoreText1 = await textOfAtomRef(mem, restores1[0]!);
    expect(restoreText1).toContain(
      "memory.store.get { path: '/run/outputs/cx2_0/data', view: 'outline' }",
    );
    expect(restoreText1).not.toContain('"$ref": "/run/outputs/');

    // Tier 2 after compaction never touches the pinned restore.
    const afterClear = await store.clearUnderPressure({
      pressureTokens: 9_900,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(afterClear?.clearedExchangeCount ?? 0).toBe(0);
    expect(restoreRefsOf(state)).toHaveLength(1);

    // Advance the conversation: narrative turns 21-23, now at turn 27.
    const lateAtoms: AiMessageAtomV1[] = [];
    for (let t = 21; t <= 23; t++) {
      lateAtoms.push(t % 2 === 0 ? userAtom(t, `late ${String(t)}`) : assistantTextAtom(t));
    }
    const lateRef = await storeBatch(mem, 'late', lateAtoms);
    state.history.atoms.push(...lateAtoms.map((a) => refOf(a, lateRef)));
    state.turnNumber = 27;

    // Tier 3 #2 — the previous restore is superseded by the merged one.
    const hydrated2 = await hydrateFromState(mem, state);
    const compact2 = await triggerCompaction(
      {
        payloadStore: mem,
        tenantId: TENANT,
        runId: RUN,
        stepId: 'agent',
        stepExecutionId: 'exec-2',
        attempt: 1,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      },
      state,
      hydrated2,
      undefined,
      mockClient(),
      'test-flow',
    );
    expect(compact2).toBeDefined();
    expect(compact2!.compactionNumber).toBe(2);

    const restores2 = restoreRefsOf(state);
    expect(restores2).toHaveLength(1);
    expect(restores2[0]!.atomId).not.toBe(restores1[0]!.atomId);
    expect(restores2[0]!.role).toBe('user');
    expect(computePinnedAtomIds(state.history.atoms, 26).has(restores2[0]!.atomId)).toBe(true);

    // In-position: the committed list stays turn-ordered around the restore.
    const turnNumbers = state.history.atoms.map((a) => a.turnNumber ?? -1);
    expect([...turnNumbers].sort((a, b) => a - b)).toEqual(turnNumbers);

    // The pointers survive the second compaction via the artifact chain.
    const artifact2 = (await mem.retrieve(
      state.compaction!.artifactRef as never,
    )) as CompactionArtifact;
    expect(artifact2.parentArtifactRef).toBeDefined();
    const refs2 = (artifact2.pinnedState.activeRefs ?? []).map((r) => r.ref);
    expect(refs2).toEqual(
      expect.arrayContaining([
        '/run/outputs/cx2_0/data',
        '/run/outputs/cx3_0/data',
        '/run/outputs/cx4_0/data',
      ]),
    );
    const restoreText2 = await textOfAtomRef(mem, restores2[0]!);
    expect(restoreText2).toContain(
      "memory.store.get { path: '/run/outputs/cx3_0/data', view: 'outline' }",
    );

    // The opening instruction is pinned through both compactions.
    expect(state.history.atoms.some((a) => a.atomId === 'user-0')).toBe(true);
  });
});

// ============================================================================
// Exchange-aware range selection — a turn-spanning exchange never splits
// ============================================================================

describe('triggerCompaction — range snaps to exchange boundaries', () => {
  it('never strands a tool_use at the range start nor orphans results at the range end', async () => {
    const mem = createMemoryPayloadStore();

    // Exchange sx straddles the range START: assistant in the pinned turn-0
    // group, its result lands in turn 1 (which is otherwise compactable).
    // Exchange ex straddles the range END: assistant at turn 16 (compactable),
    // its result at turn 17 (recency-protected with currentTurn 20).
    const atoms: AiMessageAtomV1[] = [
      userAtom(0),
      assistantToolAtom(0, 'sx', 'memory.store.query'),
      resultAtom(1, 'sx', {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 200,
      }),
    ];
    for (let t = 2; t <= 8; t++) {
      atoms.push(t % 2 === 0 ? userAtom(t, `note ${String(t)}`) : assistantTextAtom(t));
    }
    atoms.push(assistantToolAtom(16, 'ex', 'memory.store.query'));
    atoms.push(
      resultAtom(17, 'ex', {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        summaryChars: 200,
      }),
    );
    atoms.push(assistantTextAtom(18, 'recent'));

    const seedRef = await storeBatch(mem, 'seed', atoms);
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: 'c1',
      turnNumber: 20,
      context: {},
      seenSourceIds: {},
      history: {
        maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
        atoms: atoms.map((a) => refOf(a, seedRef)),
      },
    };
    const hydrated = await hydrateFromState(mem, state);
    const compact = await triggerCompaction(
      {
        payloadStore: mem,
        tenantId: TENANT,
        runId: RUN,
        stepId: 'agent',
        stepExecutionId: 'exec-1',
        attempt: 1,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      },
      state,
      hydrated,
      undefined,
      mockClient(),
      'test-flow',
    );
    expect(compact).toBeDefined();

    const ids = new Set(state.history.atoms.map((a) => a.atomId));
    // Both straddling exchanges survive WHOLE — no stranded tool_use, no
    // orphaned result.
    expect(ids.has('asst-sx')).toBe(true);
    expect(ids.has('res-sx')).toBe(true);
    expect(ids.has('asst-ex')).toBe(true);
    expect(ids.has('res-ex')).toBe(true);
    // The narrative middle was compacted into the restore.
    expect(ids.has('user-2')).toBe(false);
    expect(ids.has('asst-text-3')).toBe(false);
    expect(restoreRefsOf(state)).toHaveLength(1);

    // Pairing integrity over the residual: every surviving tool_use has its
    // result and vice versa.
    const surviving = await hydrateFromState(mem, state);
    const callIds = new Set(
      surviving.flatMap((a) => (a.message.toolCalls ?? []).map((c) => c.toolCallId)),
    );
    const resultIds = new Set(
      surviving.filter((a) => a.sourceKind === 'tool_result').map((a) => a.message.toolCallId),
    );
    expect([...callIds].sort()).toEqual([...resultIds].sort());
  });
});
