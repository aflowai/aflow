/**
 * The conversation-metadata candidate index, on a real Redis.
 *
 * Every case here is one of the ways a summary can end up describing a
 * conversation that has since moved on, or a conversation can end up with no
 * name at all because the worker that was writing one died. Lua, ZADD NX and
 * server-clock scores are the whole mechanism, so ioredis-mock would not make
 * the results mean anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import { StreamKeys, SESSION_METADATA_DEBOUNCE_MS } from '@aflow/schemas';
import {
  claimSessionMetadataCandidates,
  SESSION_METADATA_CLAIM_LEASE_MS,
  settleSessionMetadata,
  requestSessionMetadataNow,
  dropSessionMetadataCandidate,
  syncSessionMetadataCandidate,
} from '../hotState/sessionMetadataCandidates.js';

/**
 * Its own database. Claiming is "take everything due", so a suite sharing a
 * database leases these members before this one can, and filtering the result
 * client-side does not undo the lease it just took.
 */
const TEST_DB = 14;

const STACK_REDIS = await stackRedis(TEST_DB);

const TENANT = 'tenant-session-metadata-test';
const A = 'conversation-A';
const B = 'conversation-B';

describe.skipIf(!STACK_REDIS.available)('session metadata candidates', () => {
  let redis: RedisType;

  const member = (id: string) => `${TENANT}:${id}`;

  async function arm(sessionId: string, atMs = Date.now()): Promise<void> {
    const pipeline = redis.pipeline();
    syncSessionMetadataCandidate(pipeline, TENANT, sessionId, atMs, atMs);
    await pipeline.exec();
  }

  /**
   * A margin wide enough that the test process's clock and the Redis
   * container's cannot disagree across it.
   *
   * Claims compare against Redis' own clock, so a "due now" stamped a
   * millisecond in the past by a client running slightly ahead is judged not
   * yet due — the hazard the production arming path avoids by reading TIME
   * server-side. Under a loaded full-suite run that turned ten of these cases
   * red while every one of them passed alone.
   */
  const CLOCK_SKEW_MARGIN_MS = 60_000;

  /** Make an armed candidate claimable without waiting out the debounce. */
  async function makeDue(sessionId: string): Promise<void> {
    await redis.zadd(
      StreamKeys.sessionMetadataDueKey,
      Date.now() - CLOCK_SKEW_MARGIN_MS,
      member(sessionId),
    );
  }

  /**
   * Age a claim out, the way a worker dying does.
   *
   * Written rather than slept through: a short lease and a `setTimeout` agree
   * only on an idle machine, and a suite that needs an idle machine fails
   * under a full run for reasons unrelated to what it tests.
   */
  async function expireLease(sessionId: string): Promise<void> {
    await redis.zadd(
      StreamKeys.sessionMetadataLeasesKey,
      Date.now() - CLOCK_SKEW_MARGIN_MS,
      member(sessionId),
    );
  }

  async function revision(sessionId: string): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.sessionMetadataCandidatesKey, member(sessionId));
    return score === null ? null : Number(score);
  }

  async function dueAt(sessionId: string): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.sessionMetadataDueKey, member(sessionId));
    return score === null ? null : Number(score);
  }

  async function clearOwn(): Promise<void> {
    for (const id of [A, B]) await dropSessionMetadataCandidate(redis, TENANT, id);
  }

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    await clearOwn();
  });

  afterEach(async () => {
    await clearOwn();
    redis.disconnect();
  });

  it('holds a conversation back for the debounce so an answer joins the same pass', async () => {
    const now = Date.now();
    await arm(A, now);
    expect(await claimSessionMetadataCandidates(redis, 10)).toEqual([]);
    expect(await dueAt(A)).toBeGreaterThanOrEqual(now + SESSION_METADATA_DEBOUNCE_MS);

    // The agent answers half a second later. It raises the evidence revision
    // and leaves the debounce where the request set it, so the two are named
    // together rather than the answer pushing its own name out.
    await arm(A, now + 500);
    expect(await revision(A)).toBe(2);
    expect(await dueAt(A)).toBe(now + SESSION_METADATA_DEBOUNCE_MS);
  });

  it('keeps a conversation due when someone speaks mid-generation', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    expect(claimed).toBeDefined();

    // The boundary the old unversioned design lost.
    await arm(A);

    const settled = await settleSessionMetadata(
      redis,
      claimed!,
      'done',
      claimed!.evidenceRevision,
      60_000,
    );
    expect(settled.owned).toBe(true);
    expect(settled.superseded).toBe(true);
    expect(await revision(A)).toBeGreaterThan(claimed!.evidenceRevision);
    // Still owed, and held off by the refresh floor rather than regenerating
    // on every message of a busy room.
    expect(await dueAt(A)).toBeGreaterThan(Date.now());
  });

  it('clears a conversation whose generation covered every boundary', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    const settled = await settleSessionMetadata(
      redis,
      claimed!,
      'done',
      claimed!.evidenceRevision,
      60_000,
    );
    expect(settled).toEqual({ owned: true, superseded: false });
    expect(await revision(A)).toBeNull();
    expect(await dueAt(A)).toBeNull();
  });

  it('hands a crashed worker’s conversation to the next one at lease expiry', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    expect(claimed).toBeDefined();
    // Held while the lease stands.
    expect(await claimSessionMetadataCandidates(redis, 10)).toEqual([]);

    await expireLease(A);
    const [recovered] = await claimSessionMetadataCandidates(redis, 10);
    expect(recovered?.sessionId).toBe(A);
    expect(recovered?.evidenceRevision).toBe(claimed!.evidenceRevision);
  });

  it('refuses a settle from a worker whose claim has changed hands', async () => {
    await arm(A);
    await makeDue(A);
    const [first] = await claimSessionMetadataCandidates(redis, 10);
    expect(first).toBeDefined();
    await expireLease(A);
    // A different lease window, so the successor's token provably differs from
    // its predecessor's. In production that separation comes free — a claim is
    // only re-issued once the previous lease has genuinely run out, minutes
    // later — but forcing expiry here can land both claims in the same
    // millisecond, which would hand them the same token and let the stale
    // settle through on a technicality this case is not about.
    const [second] = await claimSessionMetadataCandidates(
      redis,
      10,
      SESSION_METADATA_CLAIM_LEASE_MS + 1_000,
    );
    expect(second).toBeDefined();
    expect(second!.leaseUntilMs).not.toBe(first!.leaseUntilMs);

    // The first worker wakes up past its lease. It must touch nothing — not
    // the candidate, and not the lease, which now belongs to its successor.
    const stale = await settleSessionMetadata(
      redis,
      first!,
      'done',
      first!.evidenceRevision,
      60_000,
    );
    expect(stale.owned).toBe(false);
    expect(await revision(A)).toBe(first!.evidenceRevision);

    const settled = await settleSessionMetadata(
      redis,
      second!,
      'done',
      second!.evidenceRevision,
      60_000,
    );
    expect(settled.owned).toBe(true);
  });

  it('counts a failure and comes back after the backoff', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    await settleSessionMetadata(redis, claimed!, 'retry', claimed!.evidenceRevision, 30_000);

    expect(await dueAt(A)).toBeGreaterThan(Date.now() + 25_000);
    expect(await claimSessionMetadataCandidates(redis, 10)).toEqual([]);

    await makeDue(A);
    const [retried] = await claimSessionMetadataCandidates(redis, 10);
    expect(retried?.attempts).toBe(1);
  });

  it('hands back a conversation a cycle ran out of budget for, uncounted', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    expect(claimed).toBeDefined();
    const dueBefore = await dueAt(A);

    await settleSessionMetadata(redis, claimed!, 'release', claimed!.evidenceRevision, 0);
    // Exactly as due as it was, and with no failure against its name — a
    // backoff here would retire a conversation nothing had tried to name.
    expect(await dueAt(A)).toBe(dueBefore);
    const [again] = await claimSessionMetadataCandidates(redis, 10);
    expect(again?.sessionId).toBe(A);
    expect(again?.attempts).toBe(0);
  });

  it('comes back shortly for a conversation whose evidence has not landed yet', async () => {
    // The reply is in Redis and not yet in Postgres. Waiting is not a failure
    // — counting it as one would retire a conversation over projection lag.
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    expect(claimed).toBeDefined();

    await settleSessionMetadata(redis, claimed!, 'release', claimed!.evidenceRevision, 2_000);
    expect(await dueAt(A)).toBeGreaterThan(Date.now());
    expect(await claimSessionMetadataCandidates(redis, 10)).toEqual([]);

    await makeDue(A);
    const [again] = await claimSessionMetadataCandidates(redis, 10);
    expect(again?.sessionId).toBe(A);
    expect(again?.attempts).toBe(0);
    expect(again?.evidenceRevision).toBe(claimed!.evidenceRevision);
  });

  it('retires a conversation that is not one', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    await settleSessionMetadata(redis, claimed!, 'retire', claimed!.evidenceRevision, 60_000);
    expect(await revision(A)).toBeNull();
    expect(await dueAt(A)).toBeNull();
  });

  it('lets an explicit request overrule the refresh floor', async () => {
    await arm(A);
    await makeDue(A);
    const [claimed] = await claimSessionMetadataCandidates(redis, 10);
    expect(claimed).toBeDefined();
    await settleSessionMetadata(redis, claimed!, 'retry', claimed!.evidenceRevision, 600_000);
    expect(await claimSessionMetadataCandidates(redis, 10)).toEqual([]);

    await requestSessionMetadataNow(redis, TENANT, A);
    const [regenerated] = await claimSessionMetadataCandidates(redis, 10);
    expect(regenerated?.sessionId).toBe(A);
    // A person asking is not the churn the backoff exists to prevent, so the
    // failure count starts over too.
    expect(regenerated?.attempts).toBe(0);
  });

  it('bounds one cycle to its batch and leaves the rest due', async () => {
    await arm(A);
    await arm(B);
    await makeDue(A);
    await makeDue(B);
    const first = await claimSessionMetadataCandidates(redis, 1);
    expect(first).toHaveLength(1);
    const second = await claimSessionMetadataCandidates(redis, 5);
    expect(second).toHaveLength(1);
    expect(second[0]?.sessionId).not.toBe(first[0]?.sessionId);
  });

  it('arms nothing when the write carries no conversational activity', async () => {
    const pipeline = redis.pipeline();
    syncSessionMetadataCandidate(pipeline, TENANT, A, undefined, Date.now());
    await pipeline.exec();
    expect(await revision(A)).toBeNull();
  });
});
