import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { createMemoryDocRepository, createTenantContext, tenantMemberships } from '@aflow/database';
import { backgroundWorkVerboseLogsEnabled } from '@aflow/lib';
import {
  ENTITY_EVENTS_PUBSUB_CHANNEL,
  createSubscriberConnection,
  getRedisConfig,
} from '@aflow/redis';
import {
  type ActiveSurfaceCoach,
  type ActiveSurfaceHelmsman,
  type ActiveSurfaceRun,
  type ActiveSurfaceSnapshot,
  type ActiveSurfaceTransition,
  AnomalyReportSchema,
  type CoachAnomalySummary,
  type CoachSurfaceDelta,
  type CoachSurfaceSnapshot,
  type TenantId,
} from '@aflow/schemas';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import { canReadSpace } from './authz.js';

const ANOMALY_SCAN_LIMIT = 500;

const ANOMALY_OUTBOUND_LIMIT = 100;

const ANOMALY_PATH_PREFIX = '/coach/anomalies/';

// ============================================================================
// Source IO — injectable so tests can drive the diff logic without
// standing up a real DB / Redis.
// ============================================================================

export interface CoachSurfaceSourceDeps {
  buildActiveSurface: (params: {
    db: PostgresJsDatabase;
    redis: Redis;
    tenantId: string;
    spaceId: string;
  }) => Promise<ActiveSurfaceSnapshot>;
  listPendingAnomalies: (
    db: PostgresJsDatabase,
    tenantId: TenantId,
    spaceId: string,
  ) => Promise<CoachAnomalySummary[]>;
}

/**
 * Default source: thin adapter over `buildActiveSurface` (from
 * `@aflow/cybernetic-runtime`) and a memory-doc scan of the
 * `/coach/anomalies/` prefix. Wired in by the app's topic registration.
 */
export async function defaultListPendingAnomalies(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
): Promise<CoachAnomalySummary[]> {
  const tenantCtx = createTenantContext(tenantId);
  const repo = createMemoryDocRepository(db, tenantCtx);

  const docs = await repo.list({
    pathPrefix: ANOMALY_PATH_PREFIX,
    scope: { spaceId },
    filters: { docType: ['json'] },
    limit: ANOMALY_SCAN_LIMIT,
  });

  const summaries: CoachAnomalySummary[] = [];
  for (const d of docs) {
    if (!d.path.endsWith('.json')) continue;
    const full = await repo.getById(d.id, spaceId);
    if (!full?.inlineContent) continue;
    try {
      const ar = AnomalyReportSchema.parse(JSON.parse(full.inlineContent));
      if (ar.acknowledged) continue;
      const summary: CoachAnomalySummary = {
        id: ar.id,
        kind: ar.kind,
        severity: ar.severity,
        summary: ar.summary,
        reportedAt: ar.reportedAt,
        acknowledged: ar.acknowledged,
        coachSessionId: ar.coachSessionId,
        ...(ar.acknowledgedBy !== undefined ? { acknowledgedBy: ar.acknowledgedBy } : {}),
        ...(ar.acknowledgedAt !== undefined ? { acknowledgedAt: ar.acknowledgedAt } : {}),
        ...(ar.relatedStagedChangeId !== undefined
          ? { relatedStagedChangeId: ar.relatedStagedChangeId }
          : {}),
      };
      summaries.push(summary);
    } catch {
      // Skip malformed reports — same behaviour as the REST endpoint.
    }
  }

  summaries.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  return summaries.slice(0, ANOMALY_OUTBOUND_LIMIT);
}

// ============================================================================
// Pure diff — exported for unit tests
// ============================================================================

export function diffCoachSurface(
  prev: CoachSurfaceSnapshot | null,
  next: CoachSurfaceSnapshot,
): CoachSurfaceDelta[] {
  const deltas: CoachSurfaceDelta[] = [];

  if (!prev || !coachEqual(prev.coach, next.coach)) {
    deltas.push({ kind: 'lifecycle', coach: next.coach });
  }

  if (!prev) {
    for (const a of next.anomalies) deltas.push({ kind: 'anomaly_added', anomaly: a });
  } else {
    const prevIds = new Set(prev.anomalies.map((a) => a.id));
    const nextIds = new Set(next.anomalies.map((a) => a.id));
    for (const a of next.anomalies) {
      if (!prevIds.has(a.id)) deltas.push({ kind: 'anomaly_added', anomaly: a });
    }
    for (const a of prev.anomalies) {
      if (!nextIds.has(a.id)) deltas.push({ kind: 'anomaly_resolved', anomalyId: a.id });
    }
  }

  if (!prev || !surfacedRunsEqual(prev.surfacedRuns, next.surfacedRuns)) {
    deltas.push({ kind: 'surfaced_runs', surfacedRuns: next.surfacedRuns });
  }

  if (!prev || !helmsmanEqual(prev.helmsman, next.helmsman)) {
    deltas.push({ kind: 'helmsman', helmsman: next.helmsman });
  }

  if (!prev || !transitionsEqual(prev.recentTransitions, next.recentTransitions)) {
    deltas.push({ kind: 'transitions', recentTransitions: next.recentTransitions });
  }

  return deltas;
}

function coachEqual(a: ActiveSurfaceCoach, b: ActiveSurfaceCoach): boolean {
  return (
    a.lifecycle === b.lifecycle &&
    a.coachSessionId === b.coachSessionId &&
    a.pendingProposals === b.pendingProposals &&
    a.pendingPlatformIssues === b.pendingPlatformIssues &&
    a.pendingAnomalies === b.pendingAnomalies
  );
}

function helmsmanEqual(a: ActiveSurfaceHelmsman, b: ActiveSurfaceHelmsman): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.lifecycle === b.lifecycle &&
    a.mode === b.mode &&
    a.triggerSource === b.triggerSource &&
    a.lastInteractionAt === b.lastInteractionAt
  );
}

/**
 * Order-aware comparison via a stable per-run marker. The marker captures
 * everything the UI keys off (lifecycle, ends, fidelity, task statuses);
 * if any of those change for any run, or the run set itself changes, we
 * re-emit the whole array.
 */
function surfacedRunsEqual(
  a: readonly ActiveSurfaceRun[],
  b: readonly ActiveSurfaceRun[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (runMarker(a[i]!) !== runMarker(b[i]!)) return false;
  }
  return true;
}

function runMarker(r: ActiveSurfaceRun): string {
  const taskMark = r.tasks.map((t) => `${t.taskId}:${t.status}`).join(',');
  return `${r.runId}|${r.lifecycle}|${r.endedAt ?? ''}|${r.graphFidelity}|${taskMark}`;
}

function transitionsEqual(
  a: readonly ActiveSurfaceTransition[],
  b: readonly ActiveSurfaceTransition[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.at !== y.at || x.kind !== y.kind || x.label !== y.label) return false;
  }
  return true;
}

// ============================================================================
// Pool entry + handler
// ============================================================================

interface Subscriber {
  emit: TopicSubscribeContext['emit'];
  subscriptionId: string;
  topicKey: string;
}

type RebuildTrigger = 'entity_event' | 'reconnect' | 'deadline' | 'subscriber_joined';

interface PoolEntry {
  tenantId: TenantId;
  spaceId: string;
  snapshot: CoachSurfaceSnapshot | null;
  nextCursor: number;
  /** Fanout set — populated in `start()` after `bootPromise` resolves. */
  subscribers: Set<Subscriber>;
  /**
   * Connections that have subscribed but not yet joined `subscribers`
   * (still awaiting bootstrap in `start()`). Without this, an early
   * cleanup during bootstrap can dispose the pool while another tab's
   * subscription is still live.
   */
  pendingSubscribers: Set<Subscriber>;
  /**
   * One-shot timer for the snapshot's own `nextTimeDerivedChangeAt`. Armed
   * only while something in the surface is on a clock; an idle space holds no
   * timer at all.
   */
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  pubsubSubscriber: Redis | null;
  pubsubCleanup: (() => Promise<void>) | null;
  bootPromise: Promise<void>;
  disposing: boolean;
  /** Coalescing rebuild request; a no-op until bootstrap has wired it up. */
  requestRebuild: (trigger: RebuildTrigger) => void;
}

/** Cleanup can flip `disposing` mid-async; avoid narrowed `entry.disposing` checks. */
function isPoolEntryDisposing(entry: PoolEntry): boolean {
  return entry.disposing;
}

function poolEntryHasAudience(entry: PoolEntry): boolean {
  return entry.subscribers.size > 0 || entry.pendingSubscribers.size > 0;
}

export interface SpaceCoachSurfaceTopicDeps {
  db: PostgresJsDatabase | null;
  redis: Redis | null;
  source: CoachSurfaceSourceDeps | null;
}

export function createSpaceCoachSurfaceTopicHandler(
  deps: SpaceCoachSurfaceTopicDeps,
): TopicHandler {
  const pool = new Map<string, PoolEntry>();

  return {
    kind: 'space.coach_surface',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'space.coach_surface') {
        return { kind: 'not_supported' };
      }
      const { db, redis, source } = deps;
      if (!db || !redis || !source) {
        return {
          kind: 'denied',
          code: 'service_unavailable',
          message: 'Coach surface requires database + Redis + cybernetic runtime',
        };
      }
      const tenantId = ctx.connection.tenantId as TenantId;
      const userId = ctx.connection.userId;
      const { spaceId } = ctx.topic;

      // Mirror `spaceActionCenter.ts` authz: active membership row, with
      // a non-prod dev-bypass that matches `requireTenant`.
      const tokenAuthMethod = ctx.connection.token.authMethod;
      const isDevBypass =
        process.env['NODE_ENV'] !== 'production' && tokenAuthMethod === 'dev_bypass';
      if (!isDevBypass) {
        const membership = await db
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
        if (!membership[0]) {
          return {
            kind: 'denied',
            code: 'subscribe_denied',
            message: 'No active tenant membership for this user',
          };
        }
      }

      // Space-level authz — `canReadSpace` matches the REST surface.
      const allowed = await canReadSpace(db, tenantId, userId, spaceId, tokenAuthMethod);
      if (!allowed) {
        return {
          kind: 'denied',
          code: 'subscribe_denied',
          message: 'No read access to this space',
        };
      }

      // Keyed by space, not by viewer: the surface carries no per-user field,
      // so a second watcher would otherwise buy a second copy of the same
      // rebuild loop. Read access is settled above, before anyone joins.
      const poolKey = `${tenantId}|${spaceId}`;
      const subscriber: Subscriber = {
        emit: ctx.emit,
        subscriptionId: ctx.subscriptionId,
        topicKey: ctx.topicKey,
      };

      let entry = pool.get(poolKey);
      if (!entry || entry.disposing) {
        entry = bootstrapPoolEntry({
          db,
          redis,
          source,
          tenantId,
          spaceId,
          pool,
          poolKey,
        });
      }
      const liveEntry = entry;
      liveEntry.pendingSubscribers.add(subscriber);
      // A snapshot already exists, so this connection is arriving after the
      // pool was built rather than being one of the subscribers it was built
      // for. That is the reconnect shape, where a wake may have been missed.
      const joinedWarmEntry = liveEntry.snapshot !== null;
      const initialCursor = String(liveEntry.nextCursor);
      let currentEntry = liveEntry;
      let subscriptionCancelled = false;

      const cleanup = async () => {
        subscriptionCancelled = true;
        const e = currentEntry;
        e.subscribers.delete(subscriber);
        e.pendingSubscribers.delete(subscriber);
        if (poolEntryHasAudience(e)) return;

        e.disposing = true;
        if (pool.get(poolKey) === e) pool.delete(poolKey);
        if (e.deadlineTimer) {
          clearTimeout(e.deadlineTimer);
          e.deadlineTimer = null;
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
          if (subscriptionCancelled || activeEntry.disposing) return;
          ctx.emit({
            type: 'reconcile_required',
            subscriptionId: ctx.subscriptionId,
            topicKey: ctx.topicKey,
            reason: 'snapshot_failed',
          });
          console.warn(`[space.coach_surface] bootstrap failed key=${poolKey}`, err);
          return;
        }

        // Unsubscribe during bootstrap must not re-bootstrap a fresh pool
        // entry for this subscription — the gateway already dropped cleanup
        // and a new entry would leak timer/pubsub until socket close.
        activeEntry.pendingSubscribers.delete(subscriber);
        if (subscriptionCancelled || activeEntry.disposing || !activeEntry.snapshot) return;
        activeEntry.subscribers.add(subscriber);
        currentEntry = activeEntry;
        ctx.emit({
          type: 'snapshot',
          subscriptionId: ctx.subscriptionId,
          topicKey: ctx.topicKey,
          cursor: String(activeEntry.nextCursor),
          data: activeEntry.snapshot,
        });
        // A warm entry's snapshot is only as fresh as its last wake. A joining
        // connection is usually a reconnect, which is exactly the case where a
        // wake may have been missed; rebuild once so it converges.
        if (joinedWarmEntry) activeEntry.requestRebuild('subscriber_joined');
      };

      return {
        kind: 'accepted',
        cursor: initialCursor,
        start,
        cleanup,
      };
    },
  };
}

interface BootstrapArgs {
  db: PostgresJsDatabase;
  redis: Redis;
  source: CoachSurfaceSourceDeps;
  tenantId: TenantId;
  spaceId: string;
  pool: Map<string, PoolEntry>;
  poolKey: string;
}

function bootstrapPoolEntry(args: BootstrapArgs): PoolEntry {
  const { db, redis, source, tenantId, spaceId, pool, poolKey } = args;

  let resolveBoot!: () => void;
  let rejectBoot!: (err: Error) => void;
  const bootPromise = new Promise<void>((resolve, reject) => {
    resolveBoot = resolve;
    rejectBoot = reject;
  });

  // Wakes are accepted from the moment the entry exists. Everything before
  // `resolveBoot()` runs under the in-flight flag, so a wake that lands while
  // the first snapshot is being assembled queues a rebuild instead of
  // vanishing into a snapshot that predates it.
  let rebuildInFlight = true;
  let rebuildRequested = false;
  let requestedTrigger: RebuildTrigger = 'entity_event';
  let bootAbandoned = false;

  const entry: PoolEntry = {
    tenantId,
    spaceId,
    snapshot: null,
    nextCursor: 0,
    subscribers: new Set<Subscriber>(),
    pendingSubscribers: new Set<Subscriber>(),
    deadlineTimer: null,
    pubsubSubscriber: null,
    pubsubCleanup: null,
    bootPromise,
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

  const armDeadline = (next: BuiltSurface | null): void => {
    if (entry.deadlineTimer) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = null;
    }
    if (entry.disposing || next?.nextTimeDerivedChangeAt === undefined) return;
    // Floor, not just a guard: the crossing is derived before the build's other
    // queries finish, so one that lands inside that window arrives already past.
    // Dropping it would leave the entry with no timer at the moment it most
    // needs one, and there is no poll behind it now.
    const delay = Math.max(Date.parse(next.nextTimeDerivedChangeAt) - Date.now(), 250);
    if (!Number.isFinite(delay)) return;
    entry.deadlineTimer = setTimeout(() => {
      entry.requestRebuild('deadline');
    }, delay);
  };

  let lastGood: Awaited<ReturnType<typeof buildSnapshot>> | null = null;

  const runRebuild = async (firstTrigger: RebuildTrigger): Promise<void> => {
    if (entry.disposing || rebuildInFlight) return;
    rebuildInFlight = true;
    let trigger = firstTrigger;
    try {
      do {
        rebuildRequested = false;
        const startedAt = Date.now();
        const next = await buildSnapshot(db, redis, source, tenantId, spaceId);
        if (isPoolEntryDisposing(entry)) return;
        // The aggregator catches its own failures and answers with an empty
        // surface rather than rejecting. Treating that as truth would emit
        // deltas that blank every watcher and store the blank as the baseline,
        // so the next real build would diff against nothing. Keep what we had.
        if (next.degraded) {
          console.warn(`[space.coach_surface] degraded build, keeping last good key=${poolKey}`);
          continue;
        }
        const deltas = diffCoachSurface(entry.snapshot, next.snapshot);
        entry.snapshot = next.snapshot;
        lastGood = next;
        if (backgroundWorkVerboseLogsEnabled()) {
          console.info('[background-work] space.coach_surface refresh', {
            tenantId,
            spaceId,
            trigger,
            durationMs: Date.now() - startedAt,
            deltaCount: deltas.length,
            surfacedRunCount: next.snapshot.surfacedRuns.length,
            anomalyCount: next.snapshot.anomalies.length,
          });
        }
        for (const delta of deltas) emitDelta(entry, delta);
        trigger = requestedTrigger;
      } while (rebuildRequested && !isPoolEntryDisposing(entry));
    } catch (err) {
      console.warn(`[space.coach_surface] refresh failed key=${poolKey}`, err);
    } finally {
      rebuildInFlight = false;
      // In the finally, because a build that threw is exactly when the clock
      // matters most: the deadline that woke it has already fired, and arming
      // only on success leaves the entry with no timer and no poll behind it.
      if (!isPoolEntryDisposing(entry)) armDeadline(lastGood);
    }
  };

  void (async () => {
    const pubsubSubscriber = createSubscriberConnection(getRedisConfig());
    const channel = ENTITY_EVENTS_PUBSUB_CHANNEL(tenantId, spaceId);
    // Every entity event on the channel is a wake. A curated subset would be a
    // hand-kept mirror of what the aggregator reads, and a missing entry would
    // be silent — coalescing already bounds the cost to one rebuild per burst.
    const handler = (received: string): void => {
      if (received !== channel) return;
      entry.requestRebuild('entity_event');
    };
    // The connection dials eagerly at construction, so the FIRST `ready` is
    // the connect the boot build follows — that build is current by definition
    // and rebuilding on it would tax every mount twice. Every `ready` after
    // that marks an outage: Pub/Sub has no replay, so the outage leaves a hole
    // the size of itself and only a rebuild closes it.
    let sawInitialReady = false;
    const onReady = (): void => {
      if (!sawInitialReady) {
        sawInitialReady = true;
        return;
      }
      entry.requestRebuild('reconnect');
    };
    let pubsubInstalled = false;
    const teardownPubsub = async (): Promise<void> => {
      try {
        pubsubSubscriber.off('message', handler);
        pubsubSubscriber.off('ready', onReady);
      } catch {
        /* idempotent */
      }
      if (pubsubInstalled) {
        try {
          await pubsubSubscriber.unsubscribe(channel);
        } catch {
          /* idempotent */
        }
      }
      try {
        await pubsubSubscriber.quit();
      } catch {
        /* idempotent */
      }
    };
    pubsubSubscriber.on('message', handler);
    entry.pubsubSubscriber = pubsubSubscriber;
    entry.pubsubCleanup = teardownPubsub;

    // Attached before the subscribe, not after: if the first one rejects, the
    // reconnect that would recover it is the only remaining path, and a listener
    // installed only on success is not there to take it. ioredis re-issues the
    // SUBSCRIBE itself once the connection is back.
    pubsubSubscriber.on('ready', onReady);

    // Subscribe before the first read, so nothing can land in between.
    try {
      await pubsubSubscriber.subscribe(channel);
      pubsubInstalled = true;
    } catch (err) {
      // The entry stays live and deaf until a reconnect, which is worse than it
      // sounds now that no poll carries it — so it is logged as an error and the
      // deadline floor is what keeps the surface moving in the meantime.
      console.error(
        `[space.coach_surface] pubsub subscribe failed, surface is wake-less until reconnect key=${poolKey}`,
        err,
      );
    }
    if (isPoolEntryDisposing(entry) && entry.pubsubSubscriber === pubsubSubscriber) {
      // cleanup() ran during the await — `subscribe.ts` clears
      // `pubsubCleanup`/`pubsubSubscriber` on the entry but cannot
      // tear down a connection that hadn't been written there yet at
      // the time it sampled the fields. Do it here.
      entry.pubsubSubscriber = null;
      entry.pubsubCleanup = null;
      await teardownPubsub();
    }

    // The channel is live before the snapshot exists, so a failed boot has to
    // take the subscription down with it — otherwise its handler keeps waking
    // an entry that has already been dropped from the pool.
    const abandonBoot = async (err: Error): Promise<void> => {
      bootAbandoned = true;
      rebuildInFlight = false;
      if (pool.get(poolKey) === entry) pool.delete(poolKey);
      entry.pubsubSubscriber = null;
      entry.pubsubCleanup = null;
      await teardownPubsub();
      rejectBoot(err);
    };

    let initial: BuiltSurface;
    try {
      initial = await buildSnapshot(db, redis, source, tenantId, spaceId);
    } catch (err) {
      await abandonBoot(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (entry.disposing) {
      await abandonBoot(new Error('subscription disposed before bootstrap completed'));
      return;
    }

    entry.snapshot = initial.snapshot;
    armDeadline(initial);
    rebuildInFlight = false;
    resolveBoot();

    if (rebuildRequested) void runRebuild(requestedTrigger);
  })();

  return entry;
}

/**
 * The surface as sent to subscribers, plus the deadline that only the
 * aggregator can compute. The deadline stays server-side: it schedules the
 * next rebuild, it is not something a client acts on.
 */
interface BuiltSurface {
  snapshot: CoachSurfaceSnapshot;
  nextTimeDerivedChangeAt?: string;
  /** The aggregator answered with its fallback rather than a real read. */
  degraded: boolean;
}

async function buildSnapshot(
  db: PostgresJsDatabase,
  redis: Redis,
  source: CoachSurfaceSourceDeps,
  tenantId: TenantId,
  spaceId: string,
): Promise<BuiltSurface> {
  const [active, anomalies] = await Promise.all([
    source.buildActiveSurface({ db, redis, tenantId, spaceId }),
    source.listPendingAnomalies(db, tenantId, spaceId),
  ]);
  return {
    degraded: active.capturedFrom === 'fallback-static',
    snapshot: {
      coach: active.coach,
      anomalies,
      helmsman: active.helmsman,
      surfacedRuns: active.surfacedRuns,
      recentTransitions: active.recentTransitions,
    },
    ...(active.nextTimeDerivedChangeAt !== undefined
      ? { nextTimeDerivedChangeAt: active.nextTimeDerivedChangeAt }
      : {}),
  };
}

function emitDelta(entry: PoolEntry, delta: CoachSurfaceDelta): void {
  entry.nextCursor += 1;
  const cursor = String(entry.nextCursor);
  for (const sub of entry.subscribers) {
    sub.emit({
      type: 'event',
      subscriptionId: sub.subscriptionId,
      topicKey: sub.topicKey,
      cursor,
      event: delta,
    });
  }
}
