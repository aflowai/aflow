import type { Redis } from 'ioredis';
import { setShardOwnershipCount } from '@aflow/observability';
import { errorContextFromUnknown } from '@aflow/schemas';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';
import {
  SHARD_COUNT,
  INSTANCE_LEASE_TTL_MS,
  shardFor,
  acquireAvailableShards,
  releaseShards,
  listShardPendingMessages,
  claimShardPendingMessages,
  getShardOwners,
  getShardOwnerMap,
  repairDueShardIndex,
  getActiveShardIds,
  renewLegacyShardHeartbeats,
  clearLegacyShardHeartbeats,
  buildResultStreamSet,
  buildControlStreamSet,
  type ShardStreamSet,
  type ShardStreamType,
} from '@aflow/redis';

export interface ShardManagerConfig {
  /** Unique instance identifier (typically the consumer name) */
  instanceId: string;
  /** Max shards this instance will claim. Defaults to SHARD_COUNT (all). */
  maxShards?: number;
  /** Callback invoked when shards are newly acquired (for recovery). */
  onShardsAcquired?: (shardIds: number[]) => Promise<void>;
  /**
   * Callback invoked with reclaimed pending messages that need reprocessing.
   * Called per stream type with the raw message IDs that were claimed.
   */
  onPendingReclaimed?: (shardId: number, streamType: ShardStreamType, messageCount: number) => void;
}

export interface ShardManager {
  /** Start the manager: acquire shards, begin periodic reacquisition. */
  start(): Promise<void>;
  /** Stop the manager: drain and release all owned shards. */
  stop(): Promise<void>;
  /** Check if this instance owns the shard for a given runId. */
  ownsRun(runId: string): boolean;
  /** Check if this instance owns a specific shard. */
  ownsShard(shardId: number): boolean;
  /** Get all currently owned shard IDs. */
  ownedShards(): readonly number[];
  /**
   * Stream keys and reverse lookup for the owned shards' result stream.
   * Derived state, rebuilt only when ownership changes — building it per read
   * cost 128 key allocations and a 128-entry Map on every blocking read.
   */
  resultStreams(): ShardStreamSet;
  /** Same, for the owned shards' control stream. */
  controlStreams(): ShardStreamSet;
  /** Get the fencing token for a shard (0 if not owned). */
  fencingToken(shardId: number): number;
  /** Revoke local ownership of a shard (e.g. after fencing failure). Will be re-acquired on next reacquisition cycle if available. */
  revokeShard(shardId: number): void;
  /**
   * Drop every owned shard the registry no longer grants this instance.
   * Runs at the head of each reacquisition cycle; callable directly by tests
   * and operator tools.
   */
  reconcile(): Promise<void>;
  /** Whether the manager is draining (shutting down). */
  isDraining(): boolean;
}

const REACQUISITION_INTERVAL_MS = 30_000;

/**
 * How often the reclaim sweeps every owned shard rather than only those holding
 * active runs. The narrow pass covers anything that can strand live work; this
 * is the drift backstop for a shard that went quiet with an entry still pending.
 */
const FULL_RECLAIM_INTERVAL_MS = 15 * 60_000;

/** Refresh cadence for the pre-index compatibility markers. Deleted with them. */
const LEGACY_HEARTBEAT_REFRESH_MS = 10_000;

/** Minimum idle time for DEAD-owner recovery (crash/ungraceful exit) */
const DEAD_OWNER_RECLAIM_MIN_IDLE_MS = INSTANCE_LEASE_TTL_MS;

/** Minimum idle time for STALE-but-alive owner reclaim (deploy overlap) — effectively immediate */
const STALE_OWNER_RECLAIM_MIN_IDLE_MS = 0;

export function createShardManager(redis: Redis, config: ShardManagerConfig): ShardManager {
  const log = getOrchestratorLogger().child({ component: 'shard-manager' });
  const { instanceId, maxShards = SHARD_COUNT, onShardsAcquired, onPendingReclaimed } = config;

  // Owned shards: shardId → fencingToken
  const owned = new Map<number, number>();
  // Rebuilt wherever `owned` is mutated, so there is no cache to invalidate and
  // no window in which the streams read disagree with the shards held.
  let resultStreamSet = buildResultStreamSet([]);
  let controlStreamSet = buildControlStreamSet([]);

  function refreshOwnedStreams(): void {
    const shardIds = [...owned.keys()];
    resultStreamSet = buildResultStreamSet(shardIds);
    controlStreamSet = buildControlStreamSet(shardIds);
  }
  let reacquisitionInterval: NodeJS.Timeout | null = null;
  // The interval's work, while running. Shutdown awaits it so a cycle caught
  // mid-await cannot acquire shards or fire recovery after stop() released
  // ownership; the interval skips a beat rather than overlapping it.
  let cycleInFlight: Promise<void> | null = null;
  let legacyHeartbeatInterval: NodeJS.Timeout | null = null;
  let started = false;
  let draining = false;
  // Seeded at construction: acquisition already reclaims every shard it takes,
  // so a full sweep 30s after boot would repeat work just done.
  let lastFullReclaimMs = Date.now();

  async function reclaimPendingForShards(
    shardIds: number[],
    streamTypes: ShardStreamType[] = ['control', 'results'],
  ): Promise<void> {
    // One registry read for the whole sweep rather than one per shard: the
    // registry is a single hash and the answer is the same for every shard.
    let owners = new Map<number, string>();
    try {
      owners = await getShardOwners(redis);
    } catch (err) {
      log.warn(
        'Shard registry read failed; reclaiming without owner attribution',
        err instanceof Error ? { error: err.message } : { error: String(err) },
      );
    }

    for (const shardId of shardIds) {
      const registryOwner = owners.get(shardId);

      for (const streamType of streamTypes) {
        try {
          // Check for messages idle enough for dead-owner recovery first
          const pending = await listShardPendingMessages(redis, shardId, streamType, {
            minIdleMs: STALE_OWNER_RECLAIM_MIN_IDLE_MS,
            count: 100,
          });

          if (pending.length === 0) continue;

          // Filter to messages from OTHER consumers (not ourselves)
          const foreignPending = pending.filter((p) => p.consumer !== instanceId);
          if (foreignPending.length === 0) continue;

          // Split into stale-but-alive vs potentially-dead
          const staleIds: string[] = [];
          const deadCandidateIds: string[] = [];

          for (const p of foreignPending) {
            if (registryOwner && p.consumer !== registryOwner) {
              // Consumer is NOT the current registry owner → stale, reclaim immediately
              staleIds.push(p.id);
            } else if (p.idleTime >= DEAD_OWNER_RECLAIM_MIN_IDLE_MS) {
              // Consumer might be the registry owner but message is old enough → dead-owner path
              deadCandidateIds.push(p.id);
            }
            // else: consumer IS the registry owner and message is young — leave it alone
          }

          // Reclaim stale-but-alive immediately (minIdle=0)
          if (staleIds.length > 0) {
            const claimed = await claimShardPendingMessages(
              redis,
              shardId,
              streamType,
              instanceId,
              staleIds,
              { minIdleMs: STALE_OWNER_RECLAIM_MIN_IDLE_MS },
            );
            if (claimed.length > 0) {
              log.debug(
                `Reclaimed ${String(claimed.length)} pending ${streamType} messages on shard ${String(shardId)} from stale consumers (immediate)`,
              );
              onPendingReclaimed?.(shardId, streamType, claimed.length);
            }
          }

          // Reclaim dead-owner candidates with idle threshold
          if (deadCandidateIds.length > 0) {
            const claimed = await claimShardPendingMessages(
              redis,
              shardId,
              streamType,
              instanceId,
              deadCandidateIds,
              { minIdleMs: DEAD_OWNER_RECLAIM_MIN_IDLE_MS },
            );
            if (claimed.length > 0) {
              log.debug(
                `Reclaimed ${String(claimed.length)} pending ${streamType} messages on shard ${String(shardId)} from dead consumers (timeout)`,
              );
              onPendingReclaimed?.(shardId, streamType, claimed.length);
            }
          }
        } catch (err) {
          log.error(
            `Pending reclaim failed for shard ${String(shardId)} ${streamType}`,
            err instanceof Error ? err : undefined,
            errorContextFromUnknown(err, { shardId, streamType, instanceId }),
          );
        }
      }
    }
  }

  /**
   * Drop every owned shard whose registry entry is no longer this instance's.
   *
   * In-memory ownership otherwise shrinks only on shutdown or on a fencing
   * failure during actual work — an instance resuming after a stall past its
   * liveness deadline keeps phantom ownership of every idle shard a peer took,
   * counts them against `maxShards`, and can never acquire again. The registry
   * is the authority; one hash read per cycle keeps the memory honest, and the
   * per-shard fencing tokens make dropping safe — a consumer acting on a
   * dropped shard would have been fenced anyway.
   */
  async function reconcileOwnership(): Promise<void> {
    if (owned.size === 0) return;
    const entries = await getShardOwnerMap(redis);
    const lost: number[] = [];
    for (const [shardId, fencingToken] of owned) {
      const entry = entries.get(shardId);
      if (
        entry?.owner !== instanceId ||
        entry.leaseVersion !== fencingToken ||
        entry.released === true
      ) {
        lost.push(shardId);
      }
    }
    if (lost.length === 0) return;

    for (const shardId of lost) owned.delete(shardId);
    refreshOwnedStreams();
    setShardOwnershipCount(-lost.length, { instance_id: instanceId });
    log.warn(
      `Reconciled away ${String(lost.length)} shard(s) the registry no longer grants ${instanceId}`,
      { shardIds: lost.slice(0, 16).join(','), lostCount: lost.length },
    );
  }

  async function acquireShards(): Promise<void> {
    // Pass maxShards to Redis so we never acquire more than we'll track.
    // Without this, excess shards would be leased in Redis but never
    // renewed or released by this manager — a split-brain hazard.
    const slotsAvailable = maxShards - owned.size;
    if (slotsAvailable <= 0) return;

    const acquired = await acquireAvailableShards(
      redis,
      instanceId,
      slotsAvailable,
      new Set(owned.keys()),
    );

    const newlyAcquired: number[] = [];
    for (const { shardId, fencingToken } of acquired) {
      if (!owned.has(shardId)) {
        newlyAcquired.push(shardId);
      }
      owned.set(shardId, fencingToken);
    }
    if (acquired.length > 0) refreshOwnedStreams();

    if (newlyAcquired.length > 0) {
      setShardOwnershipCount(newlyAcquired.length, { instance_id: instanceId });

      // The global due-shard index is derived state, kept in step inside the
      // same Lua as every timer write. Rebuild it for shards changing hands so
      // an entry lost to a Redis failure cannot leave their timers invisible.
      await repairDueShardIndex(redis, newlyAcquired).catch((err: unknown) => {
        log.warn(
          'Due-shard index repair failed',
          err instanceof Error ? { error: err.message } : { error: String(err) },
        );
      });

      // Reclaim pending messages from stale consumers on newly acquired shards
      await reclaimPendingForShards(newlyAcquired);

      if (onShardsAcquired) {
        try {
          await onShardsAcquired(newlyAcquired);
        } catch (err) {
          log.error(
            'onShardsAcquired callback failed',
            err instanceof Error ? err : undefined,
            errorContextFromUnknown(err, { instanceId }),
          );
        }
      }
    }
  }

  /**
   * Periodic reclaim of entries left pending by a stale consumer.
   *
   * Both consumers already re-drain their own pending entries in their read
   * loop, so this exists for the narrow case of a fenced-out instance whose
   * in-flight read landed on a shard we now own. That can only strand work on a
   * shard that has active runs, so the routine pass looks only at those — at
   * idle the set is empty and this costs a single command instead of one
   * registry read and two pending reads per configured shard.
   *
   * A shard that went quiet with an entry still pending is caught by the full
   * sweep, which is drift repair rather than a live-latency path.
   */
  async function periodicReclaim(): Promise<void> {
    if (draining) return;
    const ownedIds = [...owned.keys()];
    if (ownedIds.length === 0) return;

    if (Date.now() - lastFullReclaimMs >= FULL_RECLAIM_INTERVAL_MS) {
      await reclaimPendingForShards(ownedIds);
      // Recorded only once the sweep actually completed, so an error does not
      // consume the interval and skip the backstop for another 15 minutes.
      lastFullReclaimMs = Date.now();
      return;
    }

    // Control and results need different discovery, because they answer
    // different questions.
    //
    // A stranded result belongs to a step of a run that is by definition
    // active, so scoping that sweep to shards holding active runs loses
    // nothing. A control message does not: `start_run` and `retry_run` arrive
    // *before* their run is active — `markRunActive` runs while handling them —
    // so keying control off the active set would leave a new chat or a clicked
    // retry stranded until the 15-minute backstop. Control is swept across
    // every owned shard, which is one pending read per shard rather than the
    // registry read plus two pending reads it used to be.
    await reclaimPendingForShards(ownedIds, ['control']);

    const activeShardIds = await getActiveShardIds(redis);
    const target = activeShardIds.filter((shardId) => owned.has(shardId));
    if (target.length === 0) return;
    await reclaimPendingForShards(target, ['results']);
  }

  return {
    async start() {
      if (started) throw new Error('ShardManager already started');
      started = true;
      draining = false;

      // The count metric rides acquireShards' own delta; a second emit here
      // double-counted every boot acquisition and mis-calibrated the negative
      // deltas reconcile and stop apply later.
      await acquireShards();
      log.info(`Acquired ${String(owned.size)}/${String(SHARD_COUNT)} shards for ${instanceId}`);

      // Compatibility with the per-shard protocol, for one rollout. A process
      // still running it decides whether this one is alive by these markers, so
      // without them the first instance to deploy takes every shard the other
      // fleet owns.
      legacyHeartbeatInterval = setInterval(() => {
        if (draining) return;
        void renewLegacyShardHeartbeats(redis, instanceId, [...owned.keys()]).catch(() => {
          // Compatibility only; the liveness index is the real signal.
        });
      }, LEGACY_HEARTBEAT_REFRESH_MS);

      // Begin periodic reconcile + reacquisition + reclaim. Sequential on
      // purpose: reconcile frees the slots a phantom owner was consuming, so
      // the acquire in the same cycle can immediately take what is genuinely
      // free instead of waiting a full interval.
      reacquisitionInterval = setInterval(() => {
        if (draining || cycleInFlight) return;
        cycleInFlight = (async () => {
          // Rechecked between phases: shutdown can begin while a phase awaits
          // Redis, and the next phase must not run against released ownership.
          await reconcileOwnership().catch((err: unknown) => {
            log.error(
              'Ownership reconciliation failed',
              err instanceof Error ? err : undefined,
              errorContextFromUnknown(err, { instanceId }),
            );
          });
          if (draining) return;
          await acquireShards().catch((err: unknown) => {
            log.error(
              'Reacquisition failed',
              err instanceof Error ? err : undefined,
              errorContextFromUnknown(err, { instanceId }),
            );
          });
          if (draining) return;
          await periodicReclaim().catch((err: unknown) => {
            log.error(
              'Periodic reclaim failed',
              err instanceof Error ? err : undefined,
              errorContextFromUnknown(err, { instanceId }),
            );
          });
        })().finally(() => {
          cycleInFlight = null;
        });
      }, REACQUISITION_INTERVAL_MS);
    },

    async stop() {
      if (!started) return;

      // Set draining flag first — prevents reacquisition
      draining = true;

      if (reacquisitionInterval) {
        clearInterval(reacquisitionInterval);
        reacquisitionInterval = null;
      }

      // A cycle caught mid-await finishes its current phase and stops at the
      // next draining check; releasing ownership out from under it instead
      // would let that phase acquire or recover against a dead instance.
      if (cycleInFlight) await cycleInFlight;

      if (legacyHeartbeatInterval) {
        clearInterval(legacyHeartbeatInterval);
        legacyHeartbeatInterval = null;
      }

      const shardIds = [...owned.keys()];
      if (shardIds.length > 0) {
        setShardOwnershipCount(-shardIds.length, { instance_id: instanceId });
        // Pass fencing tokens for CAS release — only deletes registry if we still own it
        await releaseShards(redis, instanceId, shardIds, owned);
        await clearLegacyShardHeartbeats(redis, shardIds).catch(() => {
          // Compatibility only; these expire on their own.
        });
        log.debug(`Released ${String(shardIds.length)} shards for ${instanceId}`);
      }
      owned.clear();
      refreshOwnedStreams();
      started = false;
    },

    ownsRun(runId: string): boolean {
      return owned.has(shardFor(runId));
    },

    ownsShard(shardId: number): boolean {
      return owned.has(shardId);
    },

    ownedShards(): readonly number[] {
      return [...owned.keys()];
    },

    resultStreams(): ShardStreamSet {
      return resultStreamSet;
    },

    controlStreams(): ShardStreamSet {
      return controlStreamSet;
    },

    fencingToken(shardId: number): number {
      return owned.get(shardId) ?? 0;
    },

    async reconcile(): Promise<void> {
      if (draining) return;
      await reconcileOwnership();
    },

    revokeShard(shardId: number): void {
      if (owned.delete(shardId)) {
        setShardOwnershipCount(-1, { instance_id: instanceId });
        refreshOwnedStreams();
        console.warn(
          `[ShardManager] Revoked shard ${String(shardId)} — fencing indicates ownership lost. Will retry in next reacquisition cycle.`,
        );
      }
    },

    isDraining(): boolean {
      return draining;
    },
  };
}
