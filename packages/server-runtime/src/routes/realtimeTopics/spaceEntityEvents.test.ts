/**
 * Convergence tests for the per-space entity event tail.
 *
 * Every case here asserts only that a connected subscriber ends up with the
 * event — never how fast. That is deliberate: each one passed while a 5s
 * safety poll was the thing delivering it, so if the primary path is wrong
 * after the poll goes, these fail rather than quietly measuring nothing.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityEventEnvelope, ServerRealtimeMessage, TenantId } from '@aflow/schemas';
import { createFakeRedisBus, type FakeRedisBus } from './__tests__/fakeRedisBus.js';
import { createSpaceEntityEventsTopicHandler } from './spaceEntityEvents.js';

let bus: FakeRedisBus;

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aflow/redis');
  return {
    ...actual,
    getRedisConfig: () => ({}),
    createSubscriberConnection: () => bus.mintSubscriber(),
  };
});

const { appendEntityEvent, ENTITY_EVENTS_PUBSUB_CHANNEL } = await import('@aflow/redis');

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-0000000000a1';

function makeEvent(summary: string): EntityEventEnvelope {
  return {
    eventId: randomUUID(),
    eventType: 'entity.coach.activated',
    spaceId: SPACE_ID,
    tenantId: TENANT_ID,
    timestamp: Date.now(),
    payload: {},
    summary,
  };
}

async function append(summary: string): Promise<string> {
  const event = makeEvent(summary);
  await appendEntityEvent(bus.client, { tenantId: TENANT_ID, spaceId: SPACE_ID, event });
  return summary;
}

/**
 * Let every pending continuation and residual timer run. Sized well past the
 * historical safety poll so a poll-delivered result still counts as converged.
 */
async function converge(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
}

function makeCtx(emit: (msg: ServerRealtimeMessage) => void, cursor?: string) {
  return {
    connection: {
      tenantId: TENANT_ID,
      userId: 'user-a',
      token: { authMethod: 'dev_bypass' },
    },
    topic: {
      kind: 'space.entity_events',
      spaceId: SPACE_ID,
      ...(cursor !== undefined ? { cursor } : {}),
    },
    subscriptionId: 'sub-1',
    topicKey: `space.entity_events:${SPACE_ID}`,
    emit,
  } as unknown as Parameters<
    ReturnType<typeof createSpaceEntityEventsTopicHandler>['subscribe']
  >[0];
}

function makeSink(): { emit: (m: ServerRealtimeMessage) => void; summaries: () => string[] } {
  const received: ServerRealtimeMessage[] = [];
  return {
    emit: (m) => {
      received.push(m);
    },
    summaries: () =>
      received
        .filter((m): m is Extract<ServerRealtimeMessage, { type: 'event' }> => m.type === 'event')
        .map((m) => (m.event as EntityEventEnvelope).summary ?? ''),
  };
}

function subscribeTopic(emit: (m: ServerRealtimeMessage) => void, cursor?: string) {
  const handler = createSpaceEntityEventsTopicHandler({
    redis: bus.client as unknown as Redis,
    db: null,
  });
  return handler.subscribe(makeCtx(emit, cursor));
}

describe('space.entity_events tail', () => {
  beforeEach(() => {
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the backlog present at subscribe time', async () => {
    await append('e1');
    await append('e2');

    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();

    expect(sink.summaries()).toEqual(['e1', 'e2']);
    await result.cleanup();
  });

  it('delivers an event appended while the SUBSCRIBE is still in flight', async () => {
    await append('before');

    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');

    // The window the poll has been covering: the event is durable, but the
    // channel has no subscriber yet, so its wake reaches nobody.
    bus.onSubscribeInFlight(async () => {
      bus.setPublishDelivery(false);
      await append('during_subscribe');
      bus.setPublishDelivery(true);
    });

    void result.start?.();
    await converge();

    expect(sink.summaries()).toEqual(['before', 'during_subscribe']);
    await result.cleanup();
  });

  it('does not drop a wake that arrives while a drain is in flight', async () => {
    await append('e1');

    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();
    expect(sink.summaries()).toEqual(['e1']);

    // Hold a drain open, then let a second event's wake land inside it.
    const gate = bus.gateNextXrange();
    const subscriber = bus.subscribers[0];
    if (!subscriber) throw new Error('expected a subscriber connection');
    subscriber.fireMessage(
      ENTITY_EVENTS_PUBSUB_CHANNEL(TENANT_ID, SPACE_ID),
      JSON.stringify({ type: 'entity_event' }),
    );
    await gate.entered;

    bus.setPublishDelivery(false);
    await append('e2');
    bus.setPublishDelivery(true);
    subscriber.fireMessage(
      ENTITY_EVENTS_PUBSUB_CHANNEL(TENANT_ID, SPACE_ID),
      JSON.stringify({ type: 'entity_event' }),
    );
    gate.release();
    await converge();

    expect(sink.summaries()).toEqual(['e1', 'e2']);
    await result.cleanup();
  });

  it('drains a backlog larger than a single read batch', async () => {
    for (let i = 0; i < 620; i++) await append(`e${String(i)}`);

    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();

    expect(sink.summaries()).toHaveLength(620);
    expect(sink.summaries()[619]).toBe('e619');
    await result.cleanup();
  });

  it('re-drains from the cursor when the subscriber connection reconnects', async () => {
    await append('e1');

    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();
    expect(sink.summaries()).toEqual(['e1']);

    // Redis drops the subscriber. Writes keep landing; their wakes do not.
    bus.setPublishDelivery(false);
    await append('e2');
    await append('e3');
    bus.setPublishDelivery(true);

    const subscriber = bus.subscribers[0];
    if (!subscriber) throw new Error('expected a subscriber connection');
    subscriber.emitReady();
    await converge();

    expect(sink.summaries()).toEqual(['e1', 'e2', 'e3']);
    await result.cleanup();
  });

  it('resumes after the caller-supplied cursor without replaying it', async () => {
    await append('e1');
    await append('e2');

    const first = makeSink();
    const warm = await subscribeTopic(first.emit);
    if (warm.kind !== 'accepted') throw new Error('expected accepted');
    void warm.start?.();
    await converge();
    await warm.cleanup();

    // The gateway hands back the last cursor the client acknowledged.
    const resumeCursor = '1-0';
    const sink = makeSink();
    const result = await subscribeTopic(sink.emit, resumeCursor);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();

    expect(sink.summaries()).toEqual(['e2']);
    await result.cleanup();
  });

  it('stops reading once the subscription is cleaned up', async () => {
    await append('e1');
    const sink = makeSink();
    const result = await subscribeTopic(sink.emit);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    void result.start?.();
    await converge();

    await result.cleanup();
    const readsAtCleanup = bus.xrangeCalls();
    await append('e2');
    await converge();

    expect(bus.xrangeCalls()).toBe(readsAtCleanup);
    expect(sink.summaries()).toEqual(['e1']);
    expect(bus.subscribers[0]?.quitCalls).toBe(1);
  });
});

describe('appendEntityEvent', () => {
  beforeEach(() => {
    bus = createFakeRedisBus();
  });

  it('writes the event and its wake in one round trip', async () => {
    await append('e1');

    // A publish issued after the XADD has already committed can be lost on its
    // own — a durable event with no wake behind it, which is exactly what a
    // safety poll would have to exist to cover.
    expect(bus.execGroups()).toEqual([['xadd', 'expire', 'publish']]);
  });
});
