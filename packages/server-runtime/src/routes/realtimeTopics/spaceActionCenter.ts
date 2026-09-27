import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { tenantMemberships } from '@aflow/database';
import { backgroundWorkVerboseLogsEnabled } from '@aflow/lib';
import {
  type ActionCenterFocusMessage,
  ENTITY_EVENTS_PUBSUB_CHANNEL,
  createSubscriberConnection,
  getRedisConfig,
} from '@aflow/redis';
import type { ActionCenterItem, TenantId } from '@aflow/schemas';
import { StreamKeys } from '@aflow/schemas';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import type { ActionCenterAggregator } from '../../services/actionCenter/aggregator.js';
import {
  ActionCenterAuthzError,
  projectActionCenterItem,
} from '../../services/actionCenter/authz.js';
import { actionCenterItemMarker } from '../../services/actionCenter/itemMarker.js';
import { resolveActionCenterActorContext } from '../../services/actionCenter/resolveActorContext.js';
import type {
  ActionCenterContext,
  ActionCenterPooledItem,
} from '../../services/actionCenter/types.js';

/**
 * Minimum spacing between rebuild passes. Coalescing alone bounds concurrency,
 * not rate: with every entity event a wake, a busy campaign under a watching
 * tab would otherwise drive back-to-back passes as fast as the sources answer.
 * The floor is the old poll's cadence — the same worst-case read rate, with
 * none of its idle cost. A wake arriving after a quiet spell still rebuilds
 * immediately; only the passes after it wait out the cooldown.
 */
export const REBUILD_FLOOR_MS = 2_000;

type RebuildTrigger = 'wake' | 'reconnect' | 'subscriber_joined';

/** The space-shared half of a reader's list, held once however many watch it. */
interface PoolEntry {
  tenantId: TenantId;
  spaceId: string;
  snapshot: Map<string, string>;
  items: ActionCenterPooledItem[];
  subscribers: Set<Subscriber>;
  /**
   * Connections that have subscribed but not yet joined `subscribers` (still
   * awaiting bootstrap in `start()`). Without this, an early cleanup during
   * bootstrap disposes the pool another tab's subscription is still waiting on.
   */
  pendingSubscribers: Set<Subscriber>;
  /** Armed after every pass; holds the entry in-flight for `REBUILD_FLOOR_MS`. */
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  pubsubCleanup: (() => Promise<void>) | null;
  pubsubSubscriber: Redis | null;
  /** Resolves once the initial list and the pubsub wiring are up. */
  bootPromise: Promise<void>;
  /**
   * True once the initial list landed. Distinguishes a subscriber joining a
   * live entry (the reconnect shape — its items are only as fresh as the last
   * wake) from one joining a boot already in flight, whose snapshot is fresh
   * by construction and needs no converging rebuild.
   */
  booted: boolean;
  /** Sync teardown flag, set the moment cleanup decides to dispose the entry. */
  disposing: boolean;
  /** Coalescing rebuild request; queues while a rebuild (or boot) is in flight. */
  requestRebuild: (trigger: RebuildTrigger) => void;
}

/**
 * One watching connection. It carries its own reader, because the pooled items
 * are reader-free: what this person may do with a request is decided here, at
 * emit, and the client treats `allowedActions` as authorization.
 */
interface Subscriber {
  emit: TopicSubscribeContext['emit'];
  subscriptionId: string;
  topicKey: string;
  ctx: ActionCenterContext;
  /** Monotonic per connection — opaque to clients, never echoed back. */
  nextCursor: number;
  /**
   * The items only this reader can see. Invitations are the whole population:
   * pooling them would mean holding one person's rows and filtering them for
   * everybody else, which is a check where there is currently a guarantee.
   */
  personalItems: ActionCenterPooledItem[];
  personalSnapshot: Map<string, string>;
}

/** Cleanup can flip `disposing` mid-async; avoid narrowed `entry.disposing` checks. */
function isPoolEntryDisposing(entry: PoolEntry): boolean {
  return entry.disposing;
}

function poolEntryHasAudience(entry: PoolEntry): boolean {
  return entry.subscribers.size > 0 || entry.pendingSubscribers.size > 0;
}

export interface SpaceActionCenterTopicDeps {
  db: PostgresJsDatabase | null;
  redis: Redis | null;
  aggregator: ActionCenterAggregator | null;
}

export function createSpaceActionCenterTopicHandler(
  deps: SpaceActionCenterTopicDeps,
): TopicHandler {
  // One pool across all subscriptions on this server instance. Cleared
  // entry-by-entry when subscriber Sets empty out.
  const pool = new Map<string, PoolEntry>();

  return {
    kind: 'space.action_center',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'space.action_center') {
        return { kind: 'not_supported' };
      }
      const { aggregator, db, redis } = deps;
      if (!aggregator || !db) {
        return {
          kind: 'denied',
          code: 'service_unavailable',
          message: 'Action Center requires database + payload store',
        };
      }
      const tenantId = ctx.connection.tenantId as TenantId;
      const userId = ctx.connection.userId;
      const { spaceId } = ctx.topic;

      const tokenAuthMethod = ctx.connection.token.authMethod;
      const isDevBypass =
        process.env['NODE_ENV'] !== 'production' && tokenAuthMethod === 'dev_bypass';
      let isTenantAdmin = isDevBypass;
      if (!isDevBypass) {
        const tenantRows = await db
          .select({ role: tenantMemberships.role })
          .from(tenantMemberships)
          .where(
            and(
              eq(tenantMemberships.tenantId, tenantId),
              eq(tenantMemberships.userId, userId),
              eq(tenantMemberships.status, 'active'),
            ),
          )
          .limit(1);
        const tenantRole = tenantRows[0]?.role;
        if (!tenantRole) {
          return {
            kind: 'denied',
            code: 'subscribe_denied',
            message: 'No active tenant membership for this user',
          };
        }
        isTenantAdmin = tenantRole === 'owner' || tenantRole === 'admin';
      }

      let actor: ActionCenterContext;
      try {
        actor = await resolveActionCenterActorContext(db, tenantId, spaceId, {
          userId,
          isTenantAdmin,
          ...(tokenAuthMethod ? { authMethod: tokenAuthMethod } : {}),
        });
      } catch (err) {
        if (err instanceof ActionCenterAuthzError) {
          return { kind: 'denied', code: 'subscribe_denied', message: err.message };
        }
        throw err;
      }

      // Keyed by space, not by viewer: the pooled items carry no reader, so a
      // second watcher would otherwise buy a second copy of every source read
      // and a second Redis connection on a channel that is already per-space.
      const poolKey = `${tenantId}|${spaceId}`;
      const subscriber: Subscriber = {
        emit: ctx.emit,
        subscriptionId: ctx.subscriptionId,
        topicKey: ctx.topicKey,
        ctx: actor,
        nextCursor: 0,
        personalItems: [],
        personalSnapshot: new Map(),
      };

      // First subscriber for this space: synchronously install a skeleton entry
      // with a bootPromise, kick off async bootstrap. Subsequent concurrent
      // subscribers join the same entry and await the same promise — no
      // duplicate timers, no duplicate Redis subscribers.
      let entry = pool.get(poolKey);
      const joinedWarmEntry = entry !== undefined && !entry.disposing && entry.booted;
      if (!entry || entry.disposing) {
        entry = bootstrapPoolEntry({ aggregator, redis, tenantId, spaceId, pool, poolKey });
      }
      const liveEntry = entry;
      liveEntry.pendingSubscribers.add(subscriber);
      let currentEntry = liveEntry;
      let subscriptionCancelled = false;

      const cleanup = async () => {
        subscriptionCancelled = true;
        const e = currentEntry;
        e.subscribers.delete(subscriber);
        e.pendingSubscribers.delete(subscriber);
        if (poolEntryHasAudience(e)) return;

        // Sync: mark disposing, evict from pool, kill the timer. After this
        // point no new subscriber can find this entry via the pool — they
        // bootstrap a fresh one if they arrive during the async Redis cleanup.
        e.disposing = true;
        if (pool.get(poolKey) === e) pool.delete(poolKey);
        if (e.cooldownTimer) {
          clearTimeout(e.cooldownTimer);
          e.cooldownTimer = null;
        }
        if (e.pubsubCleanup) {
          try {
            await e.pubsubCleanup();
          } catch {
            /* idempotent */
          }
          e.pubsubCleanup = null;
        }
        if (e.pubsubSubscriber) {
          try {
            await e.pubsubSubscriber.quit();
          } catch {
            /* idempotent */
          }
          e.pubsubSubscriber = null;
        }
      };

      const start = async () => {
        const activeEntry = liveEntry;
        try {
          await activeEntry.bootPromise;
        } catch (err) {
          // Bootstrap failed (DB stall, source error). Emit a typed
          // reconcile_required so the client treats the snapshot path as
          // authoritative. The pool entry is already gone (bootstrap removes it
          // on reject), so this subscription receives nothing further.
          activeEntry.pendingSubscribers.delete(subscriber);
          if (subscriptionCancelled || activeEntry.disposing) return;
          ctx.emit({
            type: 'reconcile_required',
            subscriptionId: ctx.subscriptionId,
            topicKey: ctx.topicKey,
            reason: 'snapshot_failed',
          });
          console.warn(`[space.action_center] bootstrap failed key=${poolKey}`, err);
          return;
        }

        // Unsubscribe during bootstrap must not re-bootstrap a fresh pool entry
        // for this subscription — the gateway already dropped cleanup and a new
        // entry would leak its timer and Redis connection until socket close.
        if (subscriptionCancelled || activeEntry.disposing) {
          activeEntry.pendingSubscribers.delete(subscriber);
          return;
        }

        // The reader's own rows are read here rather than in the shared
        // bootstrap: they are not the same for two people in one space.
        try {
          subscriber.personalItems = await aggregator.listActorScoped(actor);
        } catch (err) {
          if (subscriptionCancelled || activeEntry.disposing) return;
          ctx.emit({
            type: 'reconcile_required',
            subscriptionId: ctx.subscriptionId,
            topicKey: ctx.topicKey,
            reason: 'snapshot_failed',
          });
          console.warn(`[space.action_center] personal snapshot failed key=${poolKey}`, err);
          return;
        }
        if (subscriptionCancelled || activeEntry.disposing) return;
        subscriber.personalSnapshot = markerMap(subscriber.personalItems);

        // By the time we get here the gateway has sent `subscribed` and the
        // client has installed its `subscriptionId → listener` route, so it is
        // safe to add to the fanout set and emit. Reading `activeEntry.items`
        // here (not at subscribe() time) means a rebuild that ran during the
        // await does not leave us emitting stale data.
        // Added to the live set before leaving the pending one, so there is no
        // instant where this subscription counts towards neither. A last
        // unsubscribe landing in that gap would see an audience of zero, dispose
        // the entry, and leave this subscription attached to nothing — with the
        // gateway having already sent `subscribed`, so the client would never
        // reconnect and the space would simply stop updating for that tab.
        activeEntry.subscribers.add(subscriber);
        activeEntry.pendingSubscribers.delete(subscriber);
        currentEntry = activeEntry;
        ctx.emit({
          type: 'snapshot',
          subscriptionId: ctx.subscriptionId,
          topicKey: ctx.topicKey,
          cursor: String(subscriber.nextCursor),
          data: { items: visibleItems(activeEntry, subscriber) },
        });
        if (joinedWarmEntry) activeEntry.requestRebuild('subscriber_joined');
      };

      return {
        kind: 'accepted',
        cursor: '0',
        start,
        cleanup,
      };
    },
  };
}

function markerMap(items: ActionCenterPooledItem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of items) m.set(it.id, actionCenterItemMarker(it));
  return m;
}

/** Everything this reader can see, projected for them, newest first. */
function visibleItems(entry: PoolEntry, sub: Subscriber): ActionCenterItem[] {
  const merged = [...entry.items, ...sub.personalItems];
  merged.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  return merged.map((item) => projectActionCenterItem(sub.ctx, item));
}

function bootstrapPoolEntry(args: {
  aggregator: ActionCenterAggregator;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: string;
  pool: Map<string, PoolEntry>;
  poolKey: string;
}): PoolEntry {
  const { aggregator, redis, tenantId, spaceId, pool, poolKey } = args;

  let resolveBoot!: () => void;
  let rejectBoot!: (err: Error) => void;
  const bootPromise = new Promise<void>((resolve, reject) => {
    resolveBoot = resolve;
    rejectBoot = reject;
  });

  // Wakes are accepted from the moment the entry exists. Everything before
  // `resolveBoot()` runs under the in-flight flag, so a wake that lands while
  // the first list is being read queues a rebuild instead of vanishing into a
  // snapshot that predates it.
  let rebuildInFlight = true;
  let rebuildRequested = false;
  let requestedTrigger: RebuildTrigger = 'wake';
  let bootAbandoned = false;

  const entry: PoolEntry = {
    tenantId,
    spaceId,
    snapshot: new Map(),
    items: [],
    subscribers: new Set<Subscriber>(),
    pendingSubscribers: new Set<Subscriber>(),
    cooldownTimer: null,
    pubsubCleanup: null,
    pubsubSubscriber: null,
    bootPromise,
    booted: false,
    disposing: false,
    requestRebuild: (trigger) => {
      if (entry.disposing || bootAbandoned) return;
      if (rebuildInFlight) {
        rebuildRequested = true;
        requestedTrigger = trigger;
        return;
      }
      void runRebuild(trigger);
    },
  };
  pool.set(poolKey, entry);

  const runRebuild = async (trigger: RebuildTrigger): Promise<void> => {
    if (entry.disposing || rebuildInFlight) return;
    rebuildInFlight = true;
    rebuildRequested = false;
    try {
      const startedAt = Date.now();
      try {
        const nextItems = await aggregator.listSpaceScoped({ tenantId, spaceId });
        if (isPoolEntryDisposing(entry)) return;

        // Each reader's own rows are diffed against that reader's own
        // baseline; a source that answers per person cannot be diffed once
        // for everyone.
        //
        // Every read happens before any baseline moves. A throw partway
        // through would otherwise leave the shared baseline advanced past a
        // delta nobody was told about, and the next rebuild would diff
        // against it and find nothing — the change lost with no reconcile
        // hint to recover it.
        const personalReads: Array<{
          sub: Subscriber;
          items: Awaited<ReturnType<typeof aggregator.listActorScoped>>;
        }> = [];
        for (const sub of [...entry.subscribers]) {
          personalReads.push({ sub, items: await aggregator.listActorScoped(sub.ctx) });
          if (isPoolEntryDisposing(entry)) return;
        }

        const nextSnapshot = markerMap(nextItems);
        const changed = diff(entry.snapshot, nextSnapshot, nextItems);
        entry.snapshot = nextSnapshot;
        entry.items = nextItems;

        const personal = new Map<Subscriber, ReturnType<typeof diff>>();
        for (const { sub, items: mine } of personalReads) {
          const mineSnapshot = markerMap(mine);
          personal.set(sub, diff(sub.personalSnapshot, mineSnapshot, mine));
          sub.personalSnapshot = mineSnapshot;
          sub.personalItems = mine;
        }

        if (backgroundWorkVerboseLogsEnabled()) {
          console.info('[background-work] space.action_center refresh', {
            tenantId,
            spaceId,
            trigger,
            durationMs: Date.now() - startedAt,
            subscribers: entry.subscribers.size,
            itemCount: nextItems.length,
            inserts: changed.inserts.length,
            updates: changed.updates.length,
            resolved: changed.resolved.length,
          });
        }

        for (const sub of [...entry.subscribers]) {
          const mine = personal.get(sub);
          const inserts = [...changed.inserts, ...(mine?.inserts ?? [])];
          const updates = [...changed.updates, ...(mine?.updates ?? [])];
          const resolved = [...changed.resolved, ...(mine?.resolved ?? [])];
          if (inserts.length) {
            emitDelta(sub, { kind: 'insert', items: project(sub, inserts) });
          }
          if (updates.length) {
            emitDelta(sub, { kind: 'update', items: project(sub, updates) });
          }
          if (resolved.length) emitDelta(sub, { kind: 'resolve', itemIds: resolved });
        }
      } catch (err) {
        console.warn(`[space.action_center] refresh failed key=${poolKey}`, err);
      }
    } finally {
      if (isPoolEntryDisposing(entry)) {
        rebuildInFlight = false;
      } else {
        // Stay in-flight through the cooldown, so every wake landing in the
        // window queues into at most one trailing pass at its end.
        entry.cooldownTimer = setTimeout(() => {
          entry.cooldownTimer = null;
          rebuildInFlight = false;
          if (!entry.disposing && rebuildRequested) void runRebuild(requestedTrigger);
        }, REBUILD_FLOOR_MS);
      }
    }
  };

  void (async () => {
    // All four channels share the entry's one subscriber connection. Wired
    // before the first read, so nothing can land in between: a publish that
    // arrives mid-boot queues a rebuild behind the in-flight flag.
    //
    // The entity-events channel is a wake too: workflow-run pauses/resumes and
    // every Coach mutation already announce themselves there, so those
    // producers need no second publish. Every event wakes the topic — a
    // curated eventType subset would be a hand-kept mirror of what the
    // sources read, and a missing entry would be silent; coalescing bounds
    // the cost to one rebuild per burst.
    const wakeChannel = StreamKeys.actionCenterWakeChannel(tenantId, spaceId);
    const tenantWakeChannel = StreamKeys.actionCenterTenantWakeChannel(tenantId);
    const entityEventsChannel = ENTITY_EVENTS_PUBSUB_CHANNEL(tenantId, spaceId);
    const focusChannel = StreamKeys.actionCenterFocusChannel(tenantId, spaceId);
    let pubsubSubscriber: Redis | null = null;
    let teardownPubsub: (() => Promise<void>) | null = null;
    if (redis) {
      const subscriberConn = createSubscriberConnection(getRedisConfig());
      const onMessage = (received: string, raw: string): void => {
        if (entry.disposing) return;
        if (
          received === wakeChannel ||
          received === tenantWakeChannel ||
          received === entityEventsChannel
        ) {
          entry.requestRebuild('wake');
          return;
        }
        if (received !== focusChannel) return;
        try {
          const parsed = JSON.parse(raw) as ActionCenterFocusMessage;
          for (const sub of [...entry.subscribers]) {
            emitDelta(sub, { kind: 'focus', message: parsed });
          }
        } catch {
          /* drop malformed messages — never crash the subscriber */
        }
      };
      // The connection dials eagerly at construction, so the FIRST `ready` is
      // the connect the boot read follows — the read is current by definition
      // and rebuilding on it would tax every mount twice. Every `ready` after
      // that marks an outage: Pub/Sub has no replay, so the outage leaves a
      // hole the size of itself and only a rebuild closes it.
      let sawInitialReady = false;
      const onReady = (): void => {
        if (!sawInitialReady) {
          sawInitialReady = true;
          return;
        }
        entry.requestRebuild('reconnect');
      };
      let channelsInstalled = false;
      // Detach only — the connection's quit stays with whoever owns the entry
      // at that point (cleanup(), or the boot-abandon paths below), so it
      // happens exactly once.
      teardownPubsub = async (): Promise<void> => {
        try {
          subscriberConn.off('message', onMessage);
          subscriberConn.off('ready', onReady);
        } catch {
          /* idempotent */
        }
        if (channelsInstalled) {
          try {
            await subscriberConn.unsubscribe(
              wakeChannel,
              tenantWakeChannel,
              entityEventsChannel,
              focusChannel,
            );
          } catch {
            /* idempotent */
          }
        }
      };
      subscriberConn.on('message', onMessage);
      // Attached before the subscribe, not after: if the first one rejects,
      // the reconnect that would recover it is the only remaining path, and a
      // listener installed only on success is not there to take it. ioredis
      // re-issues the SUBSCRIBE itself once the connection is back.
      subscriberConn.on('ready', onReady);
      pubsubSubscriber = subscriberConn;
      entry.pubsubSubscriber = subscriberConn;
      entry.pubsubCleanup = teardownPubsub;
      try {
        await subscriberConn.subscribe(
          wakeChannel,
          tenantWakeChannel,
          entityEventsChannel,
          focusChannel,
        );
        channelsInstalled = true;
      } catch (err) {
        // The entry stays live but deaf until a reconnect re-issues the
        // SUBSCRIBE. Readers still converge in the meantime: a mount, a
        // visibility return, and a joining subscriber each rebuild.
        console.error(
          `[space.action_center] pubsub subscribe failed, wake-less until reconnect key=${poolKey}`,
          err,
        );
      }
      if (isPoolEntryDisposing(entry) && entry.pubsubSubscriber === pubsubSubscriber) {
        // cleanup() ran during the await — it clears the entry's pubsub fields
        // but cannot tear down a connection that hadn't been written there yet
        // at the time it sampled them. Do it here.
        entry.pubsubSubscriber = null;
        entry.pubsubCleanup = null;
        await teardownPubsub();
        try {
          await subscriberConn.quit();
        } catch {
          /* idempotent */
        }
        rejectBoot(new Error('subscription disposed before bootstrap completed'));
        return;
      }
    }

    // The channels are live before the list exists, so a failed boot has to
    // take the subscription down with it — otherwise its handler keeps waking
    // an entry that has already been dropped from the pool.
    const abandonBoot = async (err: Error): Promise<void> => {
      bootAbandoned = true;
      rebuildInFlight = false;
      if (pool.get(poolKey) === entry) pool.delete(poolKey);
      entry.pubsubSubscriber = null;
      entry.pubsubCleanup = null;
      if (teardownPubsub) await teardownPubsub();
      if (pubsubSubscriber) {
        try {
          await pubsubSubscriber.quit();
        } catch {
          /* idempotent */
        }
      }
      rejectBoot(err);
    };

    let items: ActionCenterPooledItem[];
    try {
      items = await aggregator.listSpaceScoped({ tenantId, spaceId });
    } catch (err) {
      await abandonBoot(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (entry.disposing) {
      // Every subscriber unsubscribed before bootstrap completed.
      await abandonBoot(new Error('subscription disposed before bootstrap completed'));
      return;
    }

    entry.items = items;
    entry.snapshot = markerMap(items);
    entry.booted = true;

    rebuildInFlight = false;
    resolveBoot();

    if (rebuildRequested) void runRebuild(requestedTrigger);
  })();

  return entry;
}

interface ItemDiff {
  inserts: ActionCenterPooledItem[];
  updates: ActionCenterPooledItem[];
  resolved: string[];
}

function diff(
  prev: Map<string, string>,
  next: Map<string, string>,
  nextItems: ActionCenterPooledItem[],
): ItemDiff {
  const inserts: ActionCenterPooledItem[] = [];
  const updates: ActionCenterPooledItem[] = [];
  for (const it of nextItems) {
    const before = prev.get(it.id);
    if (before === undefined) inserts.push(it);
    else if (before !== next.get(it.id)) updates.push(it);
  }
  const resolved: string[] = [];
  for (const id of prev.keys()) {
    if (!next.has(id)) resolved.push(id);
  }
  return { inserts, updates, resolved };
}

function project(sub: Subscriber, items: ActionCenterPooledItem[]): ActionCenterItem[] {
  return items.map((item) => projectActionCenterItem(sub.ctx, item));
}

type Delta =
  | { kind: 'insert'; items: ActionCenterItem[] }
  | { kind: 'update'; items: ActionCenterItem[] }
  | { kind: 'resolve'; itemIds: string[] }
  | { kind: 'focus'; message: ActionCenterFocusMessage };

function emitDelta(sub: Subscriber, delta: Delta): void {
  sub.nextCursor += 1;
  sub.emit({
    type: 'event',
    subscriptionId: sub.subscriptionId,
    topicKey: sub.topicKey,
    cursor: String(sub.nextCursor),
    event: delta,
  });
}
