import { describe, it, expect, vi } from 'vitest';
import type {
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
  PayloadKind,
  SessionId,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { textMessage, toolResultMessage, MEMORY_READ_OPERATION_ID } from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import type { AIClient } from '@aflow/ai-client';
import { ConversationStateStore } from './conversationStateStore.js';
import { triggerCompaction } from './compaction.js';

interface RecordedWrite {
  kind: PayloadKind;
  stepExecutionId: string;
  persist: boolean | undefined;
}

function recordingStore(): { store: PayloadStore; writes: RecordedWrite[] } {
  const store = createMemoryPayloadStore();
  const writes: RecordedWrite[] = [];
  const write = store.store.bind(store);
  store.store = async (params) => {
    writes.push({
      kind: params.kind,
      stepExecutionId: params.stepExecutionId,
      persist: params.persist,
    });
    return await write(params);
  };
  return { store, writes };
}

const TENANT = 'tenant-1' as TenantId;
const RUN = 'run-1' as SessionId;
const config = {
  tenantId: TENANT,
  runId: RUN,
  stepId: 'agent',
  stepExecutionId: 'exec-1',
  attempt: 1,
};
const EXCHANGE = 'a'.repeat(32);

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

function assistantTextAtom(turnNumber: number): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-text-${String(turnNumber)}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'thinking' },
        { kind: 'json', json: { action: 'pause_for_input', message: 'thinking' } },
      ],
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function assistantToolAtom(turnNumber: number, base: string): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: `asst-${base}`,
    role: 'assistant',
    sourceId: `turn:${String(turnNumber)}`,
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_steps' } }],
      toolCalls: [
        { toolCallId: `${base}_0`, name: 'memory.store.query', argumentsJson: { q: base } },
      ],
    },
    createdAtMs: turnNumber * 1000,
    turnNumber,
  };
}

function resultAtom(turnNumber: number, base: string): AiMessageAtomV1 {
  const envelope: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${base}_0`,
    toolName: 'memory.store.query',
    operationId: 'memory.store.query',
    status: 'SUCCEEDED',
    outputPath: `/run/outputs/${base}_0`,
    summary: 'r'.repeat(2000),
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

async function seededState(
  store: PayloadStore,
  atoms: AiMessageAtomV1[],
  turnNumber: number,
): Promise<AiConversationStateV1> {
  const seedRef = await store.store({
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: `seed-${String(turnNumber)}` as StepExecutionId,
    attempt: 1,
    kind: 'history',
    data: atoms,
    persist: true,
  });
  return {
    schemaVersion: 1,
    conversationId: 'c1',
    turnNumber,
    context: {},
    seenSourceIds: {},
    history: {
      maxAtomsStructural: 200,
      atoms: atoms.map((a) => ({
        atomId: a.atomId,
        ref: seedRef,
        role: a.role,
        sourceKind: a.sourceKind,
        hash: 'h',
        createdAtMs: a.createdAtMs,
        ...(a.turnNumber !== undefined ? { turnNumber: a.turnNumber } : {}),
      })),
    },
  };
}

function summarizer(): AIClient {
  return {
    generateText: vi.fn().mockResolvedValue({
      content: '## What Was Accomplished\n- compressed',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      model: 'flash-lite',
      provider: 'google',
    }),
  } as unknown as AIClient;
}

describe('conversation state is stored without a TTL', () => {
  it('persists every write a turn, a clearing pass and a compaction make', async () => {
    const { store, writes } = recordingStore();

    const turn = new ConversationStateStore(
      { ...config, payloadStore: store },
      await seededState(store, [userAtom(0)], 1),
    );
    await turn.updateSystem('system text');
    await turn.updateContext([{ key: 'SpaceContext', content: { slug: 'desk' } }]);
    turn.appendUserInput({ userInputId: 'in-1', text: 'next', createdAtMs: 1 });
    await turn.storeTurn();

    const clearing = new ConversationStateStore(
      { ...config, payloadStore: store },
      await seededState(
        store,
        [userAtom(0), assistantToolAtom(1, EXCHANGE), resultAtom(2, EXCHANGE)],
        7,
      ),
    );
    await clearing.assembleRequest('sys', []);
    const cleared = await clearing.clearUnderPressure({
      pressureTokens: 9_000,
      effectiveBudget: 10_000,
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(cleared).toBeDefined();

    const narrative: AiMessageAtomV1[] = [userAtom(0, 'TASK: optimize the model')];
    for (let t = 1; t <= 12; t++) {
      narrative.push(t % 2 === 0 ? userAtom(t, `note ${String(t)}`) : assistantTextAtom(t));
    }
    const compacted = await triggerCompaction(
      { ...config, payloadStore: store, availableReadOpId: MEMORY_READ_OPERATION_ID },
      await seededState(store, narrative, 20),
      narrative,
      undefined,
      summarizer(),
      'test-flow',
    );
    expect(compacted).toBeDefined();

    const conversationWrites = writes.filter((w) => !w.stepExecutionId.startsWith('seed-'));
    expect(new Set(conversationWrites.map((w) => w.stepExecutionId))).toEqual(
      new Set(['exec-1', 'exec-1-archive-0', 'exec-1-clear-0', 'exec-1-compact', 'exec-1-restore']),
    );
    expect(new Set(conversationWrites.map((w) => w.kind))).toEqual(new Set(['state', 'history']));
    expect(conversationWrites.filter((w) => w.persist !== true)).toEqual([]);
  });
});
