import { describe, it, expect, vi } from 'vitest';
import type {
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
  AgentToolSpec,
  CompactionArtifact,
  TenantId,
  SessionId,
  StepExecutionId,
} from '@aflow/schemas';
import {
  DEFAULT_SUMMARY_SECTIONS,
  MEMORY_READ_OPERATION_ID,
  textMessage,
  toolResultMessage,
} from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AIClient } from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import { triggerCompaction } from './compaction.js';
import { extractNoteReadPointers } from './exchangeClearing.js';
import {
  LARGE_RESULT_MIN_TOKENS,
  MIN_CLEAR_NET_SAVINGS_TOKENS,
  RECENT_TURNS_FLOOR,
  RETENTION_POLICY,
  currentRunStartIndex,
} from './retentionPolicy.js';
import type { HandlerDeps } from './ai/handlers/types.js';
import type { AgentTurnInput } from './ai/schema.js';
import { handleAgentTurn } from './ai/handlers/agentTurn.js';
import { getAIClientForContext } from './ai/aiClient.js';

vi.mock('./ai/aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

// ============================================================================
// Fixtures — the shape agentTurn writes: a turn holds the result of the call
// before it, then the user input if any, then the next call.
// ============================================================================

const TENANT = 'tenant-test' as TenantId;
const RUN = 'run-test' as SessionId;
/** Characters of a result over LARGE_RESULT_MIN_TOKENS. */
const LARGE = 9_000;
/** The ~800-byte result a stub nearly matched in size. */
const SMALL = 800;

function userAtom(turnNumber: number, text: string): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `user-${String(turnNumber)}`,
    role: 'user',
    sourceId: `u${String(turnNumber)}`,
    sourceKind: 'user_input',
    message: textMessage('user', text),
    createdAtMs: turnNumber * 1000 + 2,
    turnNumber,
  };
}

function callAtom(
  turnNumber: number,
  base: string,
  name = 'memory.store.get',
  text?: string,
): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [
        ...(text ? [{ kind: 'text' as const, text }] : []),
        { kind: 'json', json: { action: 'invoke_step', toolId: name } },
      ],
      toolCalls: [{ toolCallId: `${base}_0`, name, argumentsJson: { path: `/docs/${base}` } }],
    },
    createdAtMs: turnNumber * 1000 + 5,
    turnNumber,
  };
}

function resultAtom(
  turnNumber: number,
  base: string,
  chars: number,
  name = 'memory.store.get',
): AiMessageAtomV1 {
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: name,
    operationId: name,
    status: 'SUCCEEDED',
    outputPath: `/run/outputs/${base}_0`,
    summary: `FACT-${base}: ${'x'.repeat(chars)}`,
  };
  return {
    schemaVersion: 1,
    atomId: `res-${base}`,
    role: 'tool',
    sourceId: `${base}_0`,
    sourceKind: 'tool_result',
    message: toolResultMessage(envelope),
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

/** One call per turn from `from` to `to`, each result landing in the next turn. */
function chain(prefix: string, from: number, to: number, chars = LARGE): AiMessageAtomV1[] {
  const atoms: AiMessageAtomV1[] = [];
  for (let t = from; t <= to; t++) {
    if (t > from) atoms.push(resultAtom(t, `${prefix}${String(t - 1)}`, chars));
    atoms.push(callAtom(t, `${prefix}${String(t)}`));
  }
  atoms.push(resultAtom(to + 1, `${prefix}${String(to)}`, chars));
  return atoms;
}

function sortedByTurn(atoms: AiMessageAtomV1[]): AiMessageAtomV1[] {
  return [...atoms].sort(
    (a, b) => (a.turnNumber ?? -1) - (b.turnNumber ?? -1) || a.createdAtMs - b.createdAtMs,
  );
}

function stateOf(atoms: AiMessageAtomV1[], turnNumber: number, ref: string): AiConversationStateV1 {
  return {
    schemaVersion: 1,
    conversationId: 'tenant-test:run-test:agent-1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    history: {
      maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural,
      atoms: atoms.map((a) => ({
        atomId: a.atomId,
        ref,
        role: a.role,
        sourceKind: a.sourceKind,
        hash: 'h',
        createdAtMs: a.createdAtMs,
        ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
      })),
    },
  };
}

async function seed(mem: PayloadStore, atoms: AiMessageAtomV1[]): Promise<string> {
  return await mem.store({
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: 'seed' as StepExecutionId,
    attempt: 1,
    kind: 'history',
    data: atoms,
  });
}

async function assembledStore(atoms: AiMessageAtomV1[], turnNumber: number) {
  const mem = createMemoryPayloadStore();
  const ordered = sortedByTurn(atoms);
  const ref = await seed(mem, ordered);
  const store = new ConversationStateStore(
    {
      payloadStore: mem,
      tenantId: TENANT,
      runId: RUN,
      stepId: 'agent-1',
      stepExecutionId: 'exec-1',
      attempt: 1,
    },
    stateOf(ordered, turnNumber, ref),
  );
  store.setTurnNumber(turnNumber - 1);
  await store.assembleRequest('sys', []);
  return { store, mem };
}

const idsOf = (store: ConversationStateStore) =>
  new Set(store.getState().history.atoms.map((a) => a.atomId));

type ClearPath = 'pressure' | 'forced';

async function clearBy(path: ClearPath, store: ConversationStateStore) {
  return path === 'pressure'
    ? await store.clearUnderPressure({
        pressureTokens: 10_000_000,
        workingBudget: 10_000,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      })
    : await store.forceClearExcess({
        excessTokens: 10_000_000,
        availableReadOpId: MEMORY_READ_OPERATION_ID,
      });
}

// ============================================================================
// The named constants
// ============================================================================

describe('retention constants', () => {
  it('holds the recency floor in the 6–10 band and gives net savings an absolute floor', () => {
    expect(RECENT_TURNS_FLOOR).toBeGreaterThanOrEqual(6);
    expect(RECENT_TURNS_FLOOR).toBeLessThanOrEqual(10);
    expect(RETENTION_POLICY.keepRecentTurns).toBe(RECENT_TURNS_FLOOR);
    expect(RETENTION_POLICY.largeResultMinTokens).toBe(LARGE_RESULT_MIN_TOKENS);
    // A tiny note no longer sets the bar at twice its own size.
    expect(RETENTION_POLICY.minClearNetSavings(10)).toBe(MIN_CLEAR_NET_SAVINGS_TOKENS);
    expect(RETENTION_POLICY.minClearNetSavings(1_000)).toBe(2_000);
  });

  it('starts the current run at the latest user_input, or at the start of history without one', () => {
    const atoms = sortedByTurn([userAtom(0, 'open'), ...chain('p', 1, 3), userAtom(5, 'next')]);
    expect(currentRunStartIndex(atoms)).toBe(atoms.findIndex((a) => a.atomId === 'user-5'));
    expect(currentRunStartIndex(chain('p', 1, 3))).toBe(-1);
  });
});

// ============================================================================
// Recency floor — both clearing paths
// ============================================================================

describe('the recency floor binds both clearing paths', () => {
  it.each<ClearPath>(['pressure', 'forced'])(
    '%s clearing never takes an exchange inside the floor, even from a finished run',
    async (path) => {
      // A finished run at turns 1..19, the next request at 20, now turn 22.
      const atoms = [userAtom(0, 'open'), ...chain('p', 1, 18), userAtom(20, 'next request')];
      const { store } = await assembledStore(atoms, 22);

      const result = await clearBy(path, store);

      // Exchange pN spans turns N and N+1, so the newest it may clear ends
      // one turn before the floor.
      const newestClearable = 22 - RECENT_TURNS_FLOOR - 2;
      const cleared = store.getState().clearing?.clearedExchanges ?? [];
      expect(result?.clearedExchangeCount).toBeGreaterThan(0);
      expect(cleared).toContain(`p${String(newestClearable)}`);
      const kept = idsOf(store);
      for (let t = newestClearable + 1; t <= 18; t++) {
        expect(cleared).not.toContain(`p${String(t)}`);
        expect(kept.has(`asst-p${String(t)}`)).toBe(true);
        expect(kept.has(`res-p${String(t)}`)).toBe(true);
      }
    },
  );
});

// ============================================================================
// Current-run exclusion — exchanges since the latest user_input
// ============================================================================

describe('the current run is never a clearing candidate', () => {
  it.each<ClearPath>(['pressure', 'forced'])(
    '%s clearing takes the finished run and leaves every exchange of the current run',
    async (path) => {
      // A finished run at 1..7, the request at 8, a long current run 8..40, now 41.
      const atoms = [
        userAtom(0, 'open'),
        ...chain('p', 1, 6),
        userAtom(8, 'next request'),
        ...chain('c', 8, 39),
      ];
      const { store } = await assembledStore(atoms, 41);

      await clearBy(path, store);

      const cleared = store.getState().clearing?.clearedExchanges ?? [];
      expect(cleared.length).toBeGreaterThan(0);
      expect(cleared.every((key) => key.startsWith('p'))).toBe(true);
      const kept = idsOf(store);
      for (let t = 8; t <= 39; t++) {
        expect(kept.has(`asst-c${String(t)}`)).toBe(true);
        expect(kept.has(`res-c${String(t)}`)).toBe(true);
      }
    },
  );

  it('treats a history without any user_input as one run and clears none of it', async () => {
    const { store } = await assembledStore(chain('c', 1, 30), 32);
    expect(await clearBy('pressure', store)).toBeUndefined();
    expect(await clearBy('forced', store)).toBeUndefined();
  });
});

// ============================================================================
// Size threshold
// ============================================================================

describe('only a large result clears to a re-readable ref', () => {
  function mixedRun(): AiMessageAtomV1[] {
    return [
      userAtom(0, 'open'),
      callAtom(1, 'small'),
      resultAtom(2, 'small', SMALL),
      callAtom(2, 'large'),
      resultAtom(3, 'large', LARGE),
      userAtom(4, 'next request'),
    ];
  }

  it.each<ClearPath>(['pressure', 'forced'])(
    '%s clearing never stubs an ~800-byte result and still clears a large one to its ref',
    async (path) => {
      const { store, mem } = await assembledStore(mixedRun(), 20);

      const result = await clearBy(path, store);

      expect(result?.clearedExchangeCount).toBe(1);
      expect(store.getState().clearing?.clearedExchanges).toEqual(['large']);
      const kept = idsOf(store);
      expect(kept.has('asst-small')).toBe(true);
      expect(kept.has('res-small')).toBe(true);

      const noteRef = store
        .getState()
        .history.atoms.find((a) => a.sourceKind === 'cleared_summary')!;
      const batch = (await mem.retrieve(noteRef.ref as never)) as AiMessageAtomV1[];
      const note = batch
        .find((a) => a.atomId === noteRef.atomId)!
        .message.parts.map((p) => (p.kind === 'text' ? p.text : ''))
        .join('\n');
      expect(extractNoteReadPointers(note)).toEqual([
        { path: '/run/outputs/large_0/data', toolName: 'memory.store.get' },
      ]);
    },
  );
});

// ============================================================================
// Compaction of a tool chain
// ============================================================================

function summarizer(content = '## What Was Read\n- compressed'): AIClient {
  return {
    generateText: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      model: 'flash-lite',
      provider: 'google',
    }),
  } as unknown as AIClient;
}

const compactionConfig = (mem: PayloadStore) => ({
  payloadStore: mem,
  tenantId: TENANT,
  runId: RUN,
  stepId: 'agent-1',
  stepExecutionId: 'exec-1',
  attempt: 1,
  availableReadOpId: MEMORY_READ_OPERATION_ID,
});

async function hydrate(mem: PayloadStore, state: AiConversationStateV1) {
  const batches = new Map<string, AiMessageAtomV1[]>();
  for (const ref of new Set(state.history.atoms.map((a) => a.ref))) {
    batches.set(ref, (await mem.retrieve(ref as never)) as AiMessageAtomV1[]);
  }
  return state.history.atoms.map((r) => batches.get(r.ref)!.find((a) => a.atomId === r.atomId)!);
}

async function compactOnce(
  mem: PayloadStore,
  state: AiConversationStateV1,
  client: AIClient = summarizer(),
) {
  return await triggerCompaction(
    compactionConfig(mem),
    state,
    await hydrate(mem, state),
    undefined,
    client,
    'test-flow',
  );
}

describe('compaction relieves a run of tool calls', () => {
  it('compacts an unbroken chain up to the floor, keeps the straddling exchange whole and the restore before it', async () => {
    const mem = createMemoryPayloadStore();
    const atoms = sortedByTurn([
      userAtom(0, 'open'),
      userAtom(1, 'the request'),
      ...chain('c', 1, 29),
    ]);
    const state = stateOf(atoms, 31, await seed(mem, atoms));

    expect(await compactOnce(mem, state)).toBeDefined();

    const after = state.history.atoms;
    const kept = new Set(after.map((a) => a.atomId));
    // The pinned opener and the run's request stay verbatim.
    expect(kept.has('user-0')).toBe(true);
    expect(kept.has('user-1')).toBe(true);
    // Turns older than the floor are gone, except the exchange that straddles it.
    const boundary = 31 - RECENT_TURNS_FLOOR - 1;
    for (let t = 1; t < boundary; t++) expect(kept.has(`asst-c${String(t)}`)).toBe(false);
    expect(kept.has(`asst-c${String(boundary)}`)).toBe(true);
    expect(kept.has(`res-c${String(boundary)}`)).toBe(true);

    // The restore takes the last compacted slot — directly before the kept
    // straddling call, never between a call and its result.
    const restoreIndex = after.findIndex((a) => a.sourceKind === 'compaction_restore');
    expect(after[restoreIndex + 1]!.atomId).toBe(`asst-c${String(boundary)}`);

    const surviving = await hydrate(mem, state);
    const callIds = surviving.flatMap((a) => (a.message.toolCalls ?? []).map((c) => c.toolCallId));
    const resultIds = surviving
      .filter((a) => a.sourceKind === 'tool_result')
      .map((a) => a.message.toolCallId);
    expect([...callIds].sort()).toEqual([...resultIds].sort());
  });

  it('never compacts the same atoms twice', async () => {
    const mem = createMemoryPayloadStore();
    const atoms = sortedByTurn([userAtom(0, 'open'), ...chain('c', 1, 29)]);
    const state = stateOf(atoms, 31, await seed(mem, atoms));
    expect(await compactOnce(mem, state)).toBeDefined();
    expect(await compactOnce(mem, state)).toBeUndefined();
  });
});

// ============================================================================
// The summary keeps what was read, decided and left pending
// ============================================================================

describe('the summary is a session summary', () => {
  it('asks for what was read, decided and left pending, and gives the summarizer the facts to fill them', async () => {
    const mem = createMemoryPayloadStore();
    const atoms = sortedByTurn([
      userAtom(0, 'Prepare the release notes for 4.2'),
      callAtom(1, 'rd1', 'memory.store.get', 'Reading the changelog first.'),
      resultAtom(2, 'rd1', 300),
      callAtom(2, 'rd2', 'memory.store.get', 'Decided: group the notes by package, not by date.'),
      resultAtom(3, 'rd2', 300),
      callAtom(
        3,
        'rd3',
        'memory.store.get',
        'Pending: ask the operator whether 4.2 ships on Friday.',
      ),
      resultAtom(4, 'rd3', 300),
      ...chain('tail', 4, 15),
    ]);
    const state = stateOf(atoms, 17, await seed(mem, atoms));
    const summary =
      '## What Was Read\n- changelog at /run/outputs/rd1_0/data\n' +
      '## What Was Decided\n- group by package\n' +
      '## Left Pending\n- ship date (turn 3)';
    const client = summarizer(summary);

    expect(await compactOnce(mem, state, client)).toBeDefined();

    const prompt = vi.mocked(client.generateText).mock.calls[0]![0].messages[0]!.content as string;
    // The template asks for the three things a resumed agent needs.
    for (const heading of ['What Was Read', 'What Was Decided', 'Left Pending']) {
      expect(DEFAULT_SUMMARY_SECTIONS.map((s) => s.heading)).toContain(heading);
      expect(prompt).toContain(`### ${heading}`);
    }
    expect(prompt).toContain('Keep what was read');
    expect(prompt).toContain('Keep what was decided');
    expect(prompt).toContain('Keep what is left pending');
    // The transcript carries turns, what was read and where, and what was said.
    expect(prompt).toContain('=== Turn 2 ===');
    expect(prompt).toContain('RESULT memory.store.get');
    expect(prompt).toContain('re-readable at /run/outputs/rd1_0/data');
    expect(prompt).toContain('FACT-rd1:');
    expect(prompt).toContain('Decided: group the notes by package, not by date.');
    expect(prompt).toContain('Pending: ask the operator whether 4.2 ships on Friday.');
    expect(prompt).toContain('CALL memory.store.get');
    // Bookkeeping stays out: no pretty-printed envelope.
    expect(prompt).not.toContain('"kind": "tool_result"');

    // The restore carries the summary and keeps every compacted read re-readable.
    const restoreRef = state.history.atoms.find((a) => a.sourceKind === 'compaction_restore')!;
    const batch = (await mem.retrieve(restoreRef.ref as never)) as AiMessageAtomV1[];
    const restore = batch
      .find((a) => a.atomId === restoreRef.atomId)!
      .message.parts.map((p) => (p.kind === 'text' ? p.text : ''))
      .join('\n');
    expect(restore).toContain(summary);
    for (const base of ['rd1', 'rd2', 'rd3']) {
      expect(restore).toContain(
        `${MEMORY_READ_OPERATION_ID} { path: '/run/outputs/${base}_0/data', view: 'outline' }`,
      );
    }
    const artifact = (await mem.retrieve(
      state.compaction!.artifactRef as never,
    )) as CompactionArtifact;
    expect(artifact.summaryModel).toBe(RETENTION_POLICY.compactionSummaryModel);
  });
});

// ============================================================================
// The ladder — compaction before clearing, and the structural cap
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

function agentClient(promptTokens: number): AIClient {
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
      usage: { promptTokens, completionTokens: 5, totalTokens: promptTokens + 5 },
    }),
    generateText: vi.fn().mockResolvedValue({
      content: '## What Was Read\n- compressed',
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

async function runTurn(atoms: AiMessageAtomV1[], turnNumber: number, promptTokens: number) {
  const mem = createMemoryPayloadStore();
  const ordered = sortedByTurn(atoms);
  const ref = await seed(mem, ordered);
  const stateRef = await mem.store({
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: 'seed' as StepExecutionId,
    attempt: 1,
    kind: 'state',
    data: stateOf(ordered, turnNumber, ref),
  });
  const writes: Array<{ kind: string; data: unknown }> = [];
  const ctx = makeCtx(writes);
  const client = agentClient(promptTokens);
  vi.mocked(getAIClientForContext).mockResolvedValue(client);
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
    turnNumber,
    model: 'test-model',
    conversationStateRef: stateRef,
  };
  const forced = vi.spyOn(ConversationStateStore.prototype, 'forceClearExcess');
  try {
    const result = await handleAgentTurn(ctx, input, deps);
    expect(result.status).toBe('SUCCEEDED');
    const output = writes.find((w) => w.kind === 'output')?.data as {
      conversationStateRef: string;
      contextEngineering?: {
        clearing?: { clearedExchanges: number };
        compaction?: { compactionNumber: number };
      };
    };
    const finalState = (await mem.retrieve(
      output.conversationStateRef as never,
    )) as AiConversationStateV1;
    const forcedResults = await Promise.all(
      forced.mock.results.map((r) => r.value as Promise<unknown>),
    );
    return {
      output,
      finalState,
      client,
      ctx,
      forcedCalls: forced.mock.calls.length,
      forcedResults,
    };
  } finally {
    forced.mockRestore();
  }
}

describe('inside the current run, compaction comes before any clearing', () => {
  it.each([
    ['above the compaction bar', 160_000],
    ['over the hard budget', 400_000],
  ])(
    '%s, the run is compacted from raw results and no exchange becomes a stub',
    async (_label, promptTokens) => {
      const atoms = [userAtom(0, 'open'), userAtom(1, 'the request'), ...chain('c', 1, 40)];
      const { output, finalState, client, forcedResults } = await runTurn(atoms, 42, promptTokens);

      expect(output.contextEngineering?.compaction).toBeDefined();
      expect(output.contextEngineering?.clearing).toBeUndefined();
      expect(finalState.history.atoms.some((a) => a.sourceKind === 'cleared_summary')).toBe(false);
      expect(finalState.clearing?.clearedExchanges ?? []).toEqual([]);
      // Whatever the forced pass was asked for, it found nothing it may take.
      for (const value of forcedResults) expect(value).toBeUndefined();

      // The summarizer read the results themselves, not stubs of them.
      const prompt = vi.mocked(client.generateText).mock.calls[0]![0].messages[0]!
        .content as string;
      expect(prompt).toContain('FACT-c2:');
      expect(prompt).not.toContain('[CLEARED RESULT STUB]');

      // The turns inside the floor are verbatim.
      const kept = new Set(finalState.history.atoms.map((a) => a.atomId));
      for (let t = 42 - RECENT_TURNS_FLOOR; t <= 40; t++) {
        expect(kept.has(`asst-c${String(t)}`)).toBe(true);
      }
    },
  );
});

describe('the structural cap triggers compaction, never clearing', () => {
  it('compacts an over-cap history at low pressure and clears no exchange', async () => {
    // A finished run of large results, every one clearable by size and age —
    // and still none is cleared, because only the atom count is high.
    const atoms = [userAtom(0, 'open'), ...chain('p', 1, 110), userAtom(112, 'next request')];
    expect(atoms.length).toBeGreaterThan(RETENTION_POLICY.maxAtomsStructural);

    const { output, finalState, ctx, forcedCalls } = await runTurn(atoms, 114, 5);

    expect(output.contextEngineering?.clearing).toBeUndefined();
    expect(finalState.history.atoms.some((a) => a.sourceKind === 'cleared_summary')).toBe(false);
    expect(forcedCalls).toBe(0);
    expect(output.contextEngineering?.compaction).toBeDefined();
    expect(ctx.log.info).toHaveBeenCalledWith(
      'agent_turn_compaction',
      expect.objectContaining({ trigger: 'structural_cap' }),
    );
    expect(finalState.history.atoms.length).toBeLessThanOrEqual(
      RETENTION_POLICY.maxAtomsStructural,
    );
  });
});
