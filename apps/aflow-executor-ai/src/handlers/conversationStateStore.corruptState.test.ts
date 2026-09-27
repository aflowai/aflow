/**
 * loadOrCreate shape discipline: a conversation-state ref that resolves to
 * anything but an AiConversationStateV1 is corrupt state — a legible,
 * non-retryable error naming the ref and the found shape — while retrieval
 * failures keep their 404 → fresh-create and transient → retry semantics.
 */
import { describe, expect, it } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';
import {
  ConversationStateCorruptError,
  ConversationStateStore,
  type ConversationStateStoreConfig,
} from './conversationStateStore.js';
import { RETENTION_POLICY } from './retentionPolicy.js';

const REF = 'gs://test-bucket/tenants/t/runs/r/steps/sex/attempt/1/state.json';

function makePayloadStore(behavior: {
  payload?: unknown;
  throwError?: Error;
}): Pick<PayloadStore, 'retrieve' | 'store'> {
  return {
    retrieve: (ref: string) => {
      if (behavior.throwError) return Promise.reject(behavior.throwError);
      if (ref === REF) return Promise.resolve(behavior.payload);
      return Promise.reject(new Error(`Payload not found: ${ref}`));
    },
    store: () => Promise.resolve('gs://test-bucket/stored' as never),
  } as Pick<PayloadStore, 'retrieve' | 'store'>;
}

function makeConfig(payloadStore: Pick<PayloadStore, 'retrieve' | 'store'>) {
  return {
    payloadStore: payloadStore as PayloadStore,
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepId: 'review',
    stepExecutionId: 'sex-1',
    attempt: 1,
  } satisfies ConversationStateStoreConfig;
}

function validState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    conversationId: 'tenant-1:run-1:review',
    turnNumber: 4,
    context: {},
    history: { atoms: [], maxAtomsStructural: 12 },
    seenSourceIds: {},
    ...overrides,
  };
}

describe('ConversationStateStore.loadOrCreate — corrupt vs transient vs missing', () => {
  it('a string payload is corrupt state — legible error naming the ref and shape, not transient', async () => {
    const doubleEncoded = JSON.stringify({ outcome: 'learning_only', rationale: 'x' }, null, 2);
    const config = makeConfig(makePayloadStore({ payload: doubleEncoded }));

    await expect(ConversationStateStore.loadOrCreate(config, REF)).rejects.toThrow(
      ConversationStateCorruptError,
    );
    await expect(ConversationStateStore.loadOrCreate(config, REF)).rejects.toThrow(
      new RegExp(`${REF}.*a string of length ${String(doubleEncoded.length)}`),
    );
  });

  it('a foreign object payload is corrupt state — the found keys are named', async () => {
    const outcomeObject = { outcome: 'silent', proposalIds: [], rationale: 'clean run this time' };
    const config = makeConfig(makePayloadStore({ payload: outcomeObject }));

    await expect(ConversationStateStore.loadOrCreate(config, REF)).rejects.toThrow(
      /an object with keys \[outcome, proposalIds, rationale\]/,
    );
  });

  it('a valid state loads and the structural cap follows the current policy', async () => {
    const config = makeConfig(makePayloadStore({ payload: validState() }));

    const store = await ConversationStateStore.loadOrCreate(config, REF);
    expect(store.turnNumber).toBe(4);
    expect(store.getState().history.maxAtomsStructural).toBe(RETENTION_POLICY.maxAtomsStructural);
  });

  it('schema defaults fill fields persisted states predate', async () => {
    const config = makeConfig(
      makePayloadStore({
        payload: validState({
          clearing: { ranges: [], clearedExchanges: [] },
        }),
      }),
    );

    const store = await ConversationStateStore.loadOrCreate(config, REF);
    expect(store.getState().clearing?.clearedCalls).toEqual([]);
    expect(store.getState().clearing?.resurrectedExchanges).toEqual([]);
  });

  it('a not-found retrieval creates fresh state', async () => {
    const config = makeConfig(
      makePayloadStore({ throwError: new Error(`Payload not found: ${REF}`) }),
    );

    const store = await ConversationStateStore.loadOrCreate(config, REF);
    expect(store.turnNumber).toBe(0);
    expect(store.getState().conversationId).toBe('tenant-1:run-1:review');
  });

  it('any other retrieval failure stays transient (retryable)', async () => {
    const config = makeConfig(makePayloadStore({ throwError: new Error('connection reset') }));

    await expect(ConversationStateStore.loadOrCreate(config, REF)).rejects.toThrow(
      /Transient error loading conversation state/,
    );
  });
});
