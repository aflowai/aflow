/**
 * Versioned projection candidates, on a real Redis.
 *
 * The set this replaces held one bit per session: dirty or not. A worker that
 * read a session, projected it, and cleared the bit erased a mutation that
 * landed in between — the durable row then held state the session had already
 * moved past, and nothing was left to say so. Every case below is one of the
 * ways that lost update happened, or one of the ways a worker dying mid-flight
 * used to strand a session.
 *
 * Lua, ZADD NX/XX and server-clock scores are the whole mechanism here, so these
 * run against real Redis; ioredis-mock does not implement them faithfully
 * enough for the result to mean anything.
 *
 * The version lives on the index, not the session hash, so nothing here reads
 * or writes that hash to move a version — a hash-borne counter resets whenever
 * a writer deletes the hash, which is the case `projectionArming` pins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import { StreamKeys } from '@aflow/schemas';
import {
  claimProjectionCandidates,
  ackProjection,
  dropProjectionCandidate,
  dropProjectionCandidateIfVersion,
} from '../hotState/projectionCandidates.js';
import { markSessionDirty } from '../hotState/dirty.js';

/**
 * Isolated to a dedicated Redis database: these write the candidate index and
 * session hashes under the same fixed key names production uses, so on db 0
 * they would take a dev orchestrator's sessions out from under it.
 *
 * Its own database, not shared with the sibling projection suite. Claiming is
 * "take everything due", so a parallel suite on the same database leases these
 * members before this one can — filtering the result client-side does not undo
 * the lease it just took. Member-scoping is enough for suites where every
 * operation names its member; it is not enough for a claim.
 */
const TEST_DB = 15;

const STACK_REDIS = await stackRedis(TEST_DB);

const TENANT = 'tenant-projection-test';
const RUN_A = 'run-A';
const RUN_B = 'run-B';

describe.skipIf(!STACK_REDIS.available)('projection candidates', () => {
  let redis: RedisType;

  const stateKey = (runId: string) => StreamKeys.sessionStateKey(TENANT, runId);
  const member = (runId: string) => `${TENANT}:${runId}`;

  async function seedSession(runId: string): Promise<void> {
    await redis.hset(stateKey(runId), 'sessionId', runId, 'status', 'RUNNING');
  }

  async function version(runId: string): Promise<number> {
    return Number(await redis.zscore(StreamKeys.projectionCandidatesKey, member(runId)));
  }

  async function clearOwn(): Promise<void> {
    const members = [member(RUN_A), member(RUN_B)];
    await redis
      .pipeline()
      .zrem(StreamKeys.projectionCandidatesKey, ...members)
      .zrem(StreamKeys.projectionOrderKey, ...members)
      .zrem(StreamKeys.projectionLeasesKey, ...members)
      .del(stateKey(RUN_A), stateKey(RUN_B))
      .exec();
  }

  /** Queued for projection and not held by a live claim. */
  async function isDue(runId: string): Promise<boolean> {
    const queued = await redis.zscore(StreamKeys.projectionOrderKey, member(runId));
    if (queued === null) return false;
    const lease = await redis.zscore(StreamKeys.projectionLeasesKey, member(runId));
    return lease === null || Number(lease) <= Date.now();
  }

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    await clearOwn();
  });

  afterEach(async () => {
    await clearOwn();
    redis.disconnect();
  });

  it('keeps a session dirty when it changes between projection read and ack', async () => {
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    const [claimed] = await claimProjectionCandidates(redis, 10);
    expect(claimed).toBeDefined();
    const readVersion = claimed!.version;

    // The mutation the old design lost: it lands while the worker is projecting.
    await markSessionDirty(redis, TENANT, RUN_A);

    expect(await ackProjection(redis, TENANT, RUN_A, readVersion, claimed!.leaseUntilMs)).toBe(
      false,
    );
    expect(await version(RUN_A)).toBeGreaterThan(readVersion);

    // ...and it is due immediately, not at lease expiry, so the newer state
    // reaches Postgres in the next cycle rather than 30s later.
    expect(await isDue(RUN_A)).toBe(true);

    const [again] = await claimProjectionCandidates(redis, 10);
    expect(again?.runId).toBe(RUN_A);
    expect(await ackProjection(redis, TENANT, RUN_A, again!.version, again!.leaseUntilMs)).toBe(
      true,
    );
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).toBeNull();
  });

  it('re-delivers a candidate whose claimant died before acknowledging', async () => {
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    // A short lease stands in for a worker that was killed mid-projection: the
    // recovery is the absence of an ack, so nothing has to notice it died.
    expect(await claimProjectionCandidates(redis, 10, 40)).toHaveLength(1);
    expect(await claimProjectionCandidates(redis, 10, 40)).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect((await claimProjectionCandidates(redis, 10, 40)).map((c) => c.runId)).toEqual([RUN_A]);
  });

  it('does not hand a claimed candidate to a second worker when it is mutated', async () => {
    // Cutting the claim short here would put two workers on the same session,
    // and their two upserts can land in either order.
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    expect(await claimProjectionCandidates(redis, 10, 60_000)).toHaveLength(1);
    await markSessionDirty(redis, TENANT, RUN_A);

    expect(await claimProjectionCandidates(redis, 10, 60_000)).toHaveLength(0);
    expect(await isDue(RUN_A)).toBe(false);
  });

  it('refuses a stale acknowledgement after the claim changed hands', async () => {
    // Acknowledging deletes the version counter, so a re-armed member restarts
    // at the value most claims hold — a worker resuming past its lease would
    // see its remembered version "match" a fresh arm and consume it. The lease
    // token is what tells the stale worker it no longer owns the claim.
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    const [staleClaim] = await claimProjectionCandidates(redis, 10);
    expect(staleClaim).toBeDefined();

    // The stall: A's lease expires and a peer takes over, projects, and acks.
    await redis.zadd(StreamKeys.projectionLeasesKey, 'XX', Date.now() - 1000, member(RUN_A));
    const [peerClaim] = await claimProjectionCandidates(redis, 10);
    expect(peerClaim?.version).toBe(staleClaim!.version);
    expect(
      await ackProjection(redis, TENANT, RUN_A, peerClaim!.version, peerClaim!.leaseUntilMs),
    ).toBe(true);

    // A fresh arm restarts the counter at the stale claim's exact version.
    await markSessionDirty(redis, TENANT, RUN_A);
    expect(await version(RUN_A)).toBe(staleClaim!.version);

    expect(
      await ackProjection(redis, TENANT, RUN_A, staleClaim!.version, staleClaim!.leaseUntilMs),
    ).toBe(false);
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).not.toBeNull();
    expect(await redis.zscore(StreamKeys.projectionOrderKey, member(RUN_A))).not.toBeNull();
  });

  it('refuses a stale guarded drop after the claim changed hands', async () => {
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    const [staleClaim] = await claimProjectionCandidates(redis, 10);
    await redis.zadd(StreamKeys.projectionLeasesKey, 'XX', Date.now() - 1000, member(RUN_A));
    const [peerClaim] = await claimProjectionCandidates(redis, 10);
    expect(
      await ackProjection(redis, TENANT, RUN_A, peerClaim!.version, peerClaim!.leaseUntilMs),
    ).toBe(true);
    await markSessionDirty(redis, TENANT, RUN_A);

    expect(
      await dropProjectionCandidateIfVersion(
        redis,
        TENANT,
        RUN_A,
        staleClaim!.version,
        staleClaim!.leaseUntilMs,
      ),
    ).toBe(false);
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).not.toBeNull();
  });

  it('does not resurrect a candidate that was dropped while being projected', async () => {
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);
    const [claimed] = await claimProjectionCandidates(redis, 10);

    // A session that can never be projected is dropped outright. A stale ack
    // arriving afterwards must not put it back.
    await dropProjectionCandidate(redis, TENANT, RUN_A);

    await ackProjection(redis, TENANT, RUN_A, claimed!.version, claimed!.leaseUntilMs);
    expect(await redis.zscore(StreamKeys.projectionOrderKey, member(RUN_A))).toBeNull();
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).toBeNull();
  });

  it('claims in the order sessions became due, oldest first', async () => {
    await seedSession(RUN_A);
    await seedSession(RUN_B);
    await markSessionDirty(redis, TENANT, RUN_A);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await markSessionDirty(redis, TENANT, RUN_B);

    // Ordering by version instead would starve a session that changes often
    // behind one that changed twice an hour ago, which is why the due time is a
    // separate score from the version.
    for (let i = 0; i < 50; i++) await markSessionDirty(redis, TENANT, RUN_A);

    expect((await claimProjectionCandidates(redis, 10)).map((c) => c.runId)).toEqual([
      RUN_A,
      RUN_B,
    ]);
  });

  it('bounds a claim by the batch limit rather than the index size', async () => {
    await seedSession(RUN_A);
    await seedSession(RUN_B);
    await markSessionDirty(redis, TENANT, RUN_A);
    await markSessionDirty(redis, TENANT, RUN_B);

    expect(await claimProjectionCandidates(redis, 1)).toHaveLength(1);
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).not.toBeNull();
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_B))).not.toBeNull();
  });

  it('marks a session that has aged out of Redis without creating a hash for it', async () => {
    // A terminal transition can arrive after the hot state has expired. It still
    // has to be projected, but reviving the hash would leave an orphan with one
    // field and no TTL.
    await markSessionDirty(redis, TENANT, RUN_A);

    expect(await redis.exists(stateKey(RUN_A))).toBe(0);
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, member(RUN_A))).not.toBeNull();

    expect(await version(RUN_A)).toBe(1);
    const [claimed] = await claimProjectionCandidates(redis, 10);
    expect(await ackProjection(redis, TENANT, RUN_A, claimed!.version, claimed!.leaseUntilMs)).toBe(
      true,
    );
  });

  it('scores from Redis, not the caller, so skewed workers agree on what is due', async () => {
    await seedSession(RUN_A);
    await markSessionDirty(redis, TENANT, RUN_A);

    const score = Number(await redis.zscore(StreamKeys.projectionOrderKey, member(RUN_A)));
    const [seconds] = (await redis.time()) as [string, string];
    expect(Math.abs(score - Number(seconds) * 1000)).toBeLessThan(2000);
  });
});
