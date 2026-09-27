/**
 * The wakeup used to carry a 500ms safety poll, which is what made an idle open
 * chat re-read its whole event stream twice a second per connection. It existed
 * to cover two gaps, and both are now closed at the source: the wake rides the
 * append's transaction, and a Pub/Sub outage is answered by a reconnect wake.
 *
 * So these pin the two properties that replaced it — a reconnect must produce a
 * *durable* wake, and nothing may fire on a timer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeSessionWakeup } from '../sessionWakeup.js';
import type { PubSubSubscriber, PubSubNotification } from '../pubsub.js';
import type { SessionId, TenantId } from '@aflow/schemas';

const TENANT = 'tenant-1' as TenantId;
const SESSION = '00000000-0000-4000-8000-000000000001' as SessionId;

function fakeSubscriber(): {
  subscriber: PubSubSubscriber;
  publish: (n: PubSubNotification) => void;
  reconnect: () => void;
  unsubscribed: () => boolean;
} {
  let onNotification: ((n: PubSubNotification) => void) | null = null;
  const reconnectHandlers = new Set<() => void>();
  let unsubscribed = false;

  const subscriber: PubSubSubscriber = {
    subscribeToRun: async (_t, _r, handler) => {
      onNotification = handler;
      return {
        unsubscribe: async () => {
          unsubscribed = true;
        },
      };
    },
    subscribeToTenant: async () => ({ unsubscribe: async () => {} }),
    onReconnect: (handler) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    close: async () => {},
  };

  return {
    subscriber,
    publish: (n) => onNotification?.(n),
    reconnect: () => {
      for (const h of reconnectHandlers) h();
    },
    unsubscribed: () => unsubscribed,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session wakeup', () => {
  it('wakes durably on a reconnect, because Pub/Sub keeps no backlog', async () => {
    const { subscriber, reconnect } = fakeSubscriber();
    const controller = new AbortController();
    const wakeup = await subscribeSessionWakeup({
      pubsubSubscriber: subscriber,
      tenantId: TENANT,
      sessionId: SESSION,
      signal: controller.signal,
    });

    reconnect();

    // Durable: anything published during the outage is unrecoverable except by
    // re-reading from the cursor.
    expect(await wakeup.next()).toEqual({ durable: true });
    await wakeup.close();
    controller.abort();
  });

  it('treats a live-delta notification as a non-durable wake', async () => {
    const { subscriber, publish } = fakeSubscriber();
    const controller = new AbortController();
    const wakeup = await subscribeSessionWakeup({
      pubsubSubscriber: subscriber,
      tenantId: TENANT,
      sessionId: SESSION,
      signal: controller.signal,
    });

    publish({ type: 'event', runId: SESSION, eventType: 'LiveDelta:text' } as PubSubNotification);
    expect(await wakeup.next()).toEqual({ durable: false });

    await wakeup.close();
    controller.abort();
  });

  it('treats a durable event notification as a durable wake', async () => {
    const { subscriber, publish } = fakeSubscriber();
    const controller = new AbortController();
    const wakeup = await subscribeSessionWakeup({
      pubsubSubscriber: subscriber,
      tenantId: TENANT,
      sessionId: SESSION,
      signal: controller.signal,
    });

    publish({ type: 'event', runId: SESSION, eventType: 'StepSucceeded' } as PubSubNotification);
    expect(await wakeup.next()).toEqual({ durable: true });

    await wakeup.close();
    controller.abort();
  });

  it('does not wake on a timer', async () => {
    // The property the poll removal is: an idle subscription costs nothing.
    vi.useFakeTimers();
    const { subscriber } = fakeSubscriber();
    const controller = new AbortController();
    const wakeup = await subscribeSessionWakeup({
      pubsubSubscriber: subscriber,
      tenantId: TENANT,
      sessionId: SESSION,
      signal: controller.signal,
    });

    let woke = false;
    void wakeup.next().then(() => {
      woke = true;
    });

    // Far longer than the poll that used to live here.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(woke).toBe(false);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await wakeup.close();
  });

  it('stops listening for reconnects once closed', async () => {
    const { subscriber, reconnect, unsubscribed } = fakeSubscriber();
    const controller = new AbortController();
    const wakeup = await subscribeSessionWakeup({
      pubsubSubscriber: subscriber,
      tenantId: TENANT,
      sessionId: SESSION,
      signal: controller.signal,
    });

    await wakeup.close();
    expect(unsubscribed()).toBe(true);

    // Must not throw or resurrect a closed subscription.
    reconnect();
    controller.abort();
  });
});
