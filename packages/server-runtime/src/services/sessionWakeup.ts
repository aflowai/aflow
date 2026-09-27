import type { SessionId, TenantId } from '@aflow/schemas';
import type { PubSubSubscriber, PubSubNotification } from './pubsub.js';

/**
 * "Something about this session may have changed" — the wakeup shared by the
 * loop that tails a session on one Pub/Sub subscription.
 *
 * A wakeup reports whether a *durable* event occurred, distinct from a
 * live-delta flush: a 150 ms live-delta flush wakes the loop to re-read the
 * cheap live buffer but must not drive the durable drain. The wake payload is
 * tagged with the event type (`LiveDelta:<channel>` for the live plane), which
 * is what lets the two be told apart here rather than on a second channel.
 *
 * There is no safety poll. It existed because a `PUBLISH` issued after the
 * append could be lost on its own, and because a Pub/Sub outage left every open
 * session waiting on a subscription that had silently missed everything. Both
 * are now closed at the source — the wake rides the append's transaction, and
 * the subscriber wakes its sessions on reconnect — so a timer that re-read the
 * stream twice a second per subscription would be paying, forever and per
 * connection, for a gap that no longer exists.
 */
export type WakeupSignal = 'abort' | { durable: boolean };

export interface SessionWakeup {
  /** Resolves on the next wakeup, or `'abort'` once the caller's signal fires. */
  next(): Promise<WakeupSignal>;
  close(): Promise<void>;
}

function isDurableNotification(notification: PubSubNotification): boolean {
  return !(notification.type === 'event' && notification.eventType.startsWith('LiveDelta:'));
}

export async function subscribeSessionWakeup(opts: {
  pubsubSubscriber: PubSubSubscriber | null;
  tenantId: TenantId;
  sessionId: SessionId;
  signal: AbortSignal;
}): Promise<SessionWakeup> {
  const { pubsubSubscriber, tenantId, sessionId, signal } = opts;

  // `wakeupPending` defends against the race where a wakeup fires BEFORE the
  // consumer awaits `next()`. Without it, the very first notification (typical
  // on a fresh chat session: the orchestrator's `SessionStarted` publishes the
  // moment subscribe returns) is dropped on the floor — the consumer is still
  // finishing its initial drain when it fires, no resolver is registered, and
  // nothing asks again. There is no poll behind this any more, so a wakeup
  // dropped here is not recovered late — it is not recovered at all, and the
  // session waits until something else happens to wake it. The symptom used to
  // be the first message after page mount appearing to hang; now it would
  // simply not arrive.
  //
  // `durablePending` accumulates across coalesced wakeups: once any durable
  // notification is seen it stays set until the consumer observes it, so a
  // durable event coalesced behind a burst of live flushes is never missed.
  let wakeupPending = false;
  let durablePending = false;
  let resolveWakeup: (() => void) | null = null;
  const wakeup = (durable: boolean) => {
    wakeupPending = true;
    if (durable) durablePending = true;
    const r = resolveWakeup;
    resolveWakeup = null;
    if (r) r();
  };
  const nextWakeup = () =>
    new Promise<WakeupSignal>((resolve) => {
      const drain = () => {
        wakeupPending = false;
        const durable = durablePending;
        durablePending = false;
        resolve({ durable });
      };
      if (wakeupPending) {
        drain();
        return;
      }
      resolveWakeup = drain;
    });

  const abortPromise = new Promise<'abort'>((resolve) => {
    const onAbort = () => {
      resolve('abort');
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  // A reconnect is a durable wake: Pub/Sub has no backlog, so anything
  // published while the connection was down is gone, and only a re-read from
  // the cursor can find it.
  //
  // Registered *before* the subscription is awaited. A reconnect landing in
  // that window would otherwise be missed, and with no poll behind it nothing
  // would ever ask again.
  const unsubscribeReconnect = pubsubSubscriber
    ? pubsubSubscriber.onReconnect(() => {
        wakeup(true);
      })
    : null;

  let subscription: { unsubscribe: () => Promise<void> } | null = null;
  if (pubsubSubscriber) {
    try {
      subscription = await pubsubSubscriber.subscribeToRun(tenantId, sessionId, (notification) => {
        wakeup(isDurableNotification(notification));
      });
    } catch (err) {
      unsubscribeReconnect?.();
      throw err;
    }
  }

  return {
    next: () => Promise.race([nextWakeup(), abortPromise]),
    close: async () => {
      unsubscribeReconnect?.();
      if (subscription) await subscription.unsubscribe().catch(() => {});
    },
  };
}
