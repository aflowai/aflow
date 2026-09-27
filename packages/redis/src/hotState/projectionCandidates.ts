import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * Sessions awaiting projection to Postgres, as three sorted sets keyed by
 * `tenantId:sessionId`.
 *
 * A worker claims a candidate, reads its version, projects, and acknowledges
 * that exact version. A mutation landing mid-flight raises the version, the
 * acknowledgement no longer matches, and the session stays a candidate. The
 * unversioned set this replaces could not tell "projected, then changed" from
 * "projected", and dropped the second write — for a run that had just reached
 * its terminal state there was no later change to save it.
 *
 * Three keys because there are three facts, and folding any two into one score
 * has cost a guarantee each time it was tried:
 *
 * - `candidates` — the version. Held here rather than on the session hash: that
 *   hash has a TTL and is deleted-then-rewritten by `setSessionState` and
 *   `atomicCreateSession`, so a counter living on it resets to zero and climbs
 *   back through values a worker in flight has already read.
 * - `order` — when the session was marked. Compared only against other marks,
 *   never against a clock, which is what makes it safe for the caller to stamp.
 *   Ordering by version instead would starve a session that changes often
 *   behind one that changed twice an hour ago.
 * - `leases` — when a claim expires, stamped from Redis and compared only
 *   against Redis' own clock. While this shared the order key, a caller-stamped
 *   "due now" was compared against the server clock, so a caller even one
 *   millisecond ahead had its own fresh mark judged not yet due.
 *
 * The lease is what makes recovery the absence of a renewal rather than the
 * presence of a reaper: a worker that dies mid-projection blocks nobody past
 * expiry, and nothing has to notice it died.
 */

export interface ProjectionCandidate {
  tenantId: string;
  runId: string;
  /** Hand back to `ackProjection` after projecting. */
  version: number;
  /**
   * The claim's lease deadline, doubling as its ownership token. The version
   * alone cannot prove ownership: acknowledging deletes the counter, so a
   * re-armed member restarts at one — the value most claims hold — and a
   * worker resuming past its lease would see its stale version "match" a
   * fresh arm and consume it. Successive claims of one member are separated
   * by the lease window, so no two ever share this value.
   */
  leaseUntilMs: number;
}

/**
 * How long a claim holds a candidate before another worker may take it.
 *
 * Long enough that a slow projection is not handed to a second worker while the
 * first is still writing, short enough that a killed worker's candidates are
 * picked up well inside the projection-lag objective.
 */
export const PROJECTION_CLAIM_LEASE_MS = 30_000;

/**
 * Arm a session for projection: raise its version and record when it was
 * marked.
 *
 * NX holds a session's place in the queue at its *first* unprojected mark, so a
 * session mutating in a tight loop can neither push itself to the back nor jump
 * ahead of older work.
 *
 * This is the ONLY way a session becomes a candidate. A second one is how the
 * mark and the worker's discovery drifted apart before — a guard test fails if
 * these keys are written outside this module.
 */
export function markProjectionCandidate(pipeline: ChainableCommander, member: string): void {
  pipeline.zincrby(StreamKeys.projectionCandidatesKey, 1, member);
  pipeline.zadd(StreamKeys.projectionOrderKey, 'NX', Date.now(), member);
}

const NOW_MS_LUA = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

const CLAIM_CANDIDATES_LUA = `
${NOW_MS_LUA}
local limit = tonumber(ARGV[1])

-- Expired leases first, so what remains is exactly what is genuinely in flight
-- — which is also exactly how far past the head of the queue this read has to
-- look to fill the batch with unclaimed members.
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', nowMs)
local inFlight = redis.call('ZCARD', KEYS[3])

local oldest = redis.call('ZRANGE', KEYS[2], 0, limit + inFlight - 1)
local leaseUntil = nowMs + tonumber(ARGV[2])
local out = { leaseUntil }
local taken = 0
for i = 1, #oldest do
  if taken >= limit then break end
  local member = oldest[i]
  if redis.call('ZSCORE', KEYS[3], member) == false then
    local version = redis.call('ZSCORE', KEYS[1], member)
    if version then
      redis.call('ZADD', KEYS[3], leaseUntil, member)
      out[#out + 1] = member
      out[#out + 1] = version
      taken = taken + 1
    else
      -- Queued with no version is not a candidate: drop it rather than hand the
      -- worker something it can never acknowledge.
      redis.call('ZREM', KEYS[2], member)
    end
  end
end
return out
`;

/**
 * Claim up to `limit` candidates, oldest mark first, holding each for the lease
 * window.
 *
 * Bounded by design: the read looks at the head of the queue plus however many
 * claims are in flight, so its cost tracks pending work rather than how many
 * sessions exist.
 */
export async function claimProjectionCandidates(
  redis: Redis,
  limit: number,
  leaseMs: number = PROJECTION_CLAIM_LEASE_MS,
): Promise<ProjectionCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.eval(
    CLAIM_CANDIDATES_LUA,
    3,
    StreamKeys.projectionCandidatesKey,
    StreamKeys.projectionOrderKey,
    StreamKeys.projectionLeasesKey,
    String(limit),
    String(leaseMs),
  );
  if (!Array.isArray(raw)) return [];
  const leaseUntilMs = Number(raw[0]);
  const out: ProjectionCandidate[] = [];
  for (let i = 1; i + 1 < raw.length; i += 2) {
    const parsed = parseSessionCandidateMember(String(raw[i]));
    if (parsed) {
      out.push({
        tenantId: parsed.tenantId,
        runId: parsed.sessionId,
        version: Number(raw[i + 1]),
        leaseUntilMs,
      });
    }
  }
  return out;
}

const ACK_PROJECTION_LUA = `
local member = ARGV[1]
-- Ownership first: the version alone cannot prove it, because acknowledging
-- deletes the counter and a re-armed member restarts at the value most claims
-- hold. A worker whose lease is no longer its own has been succeeded — it must
-- touch nothing, not even the lease, which now belongs to the successor.
local lease = redis.call('ZSCORE', KEYS[3], member)
if not lease or tonumber(lease) ~= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZREM', KEYS[3], member)

local current = redis.call('ZSCORE', KEYS[1], member)
if current and tonumber(current) ~= tonumber(ARGV[2]) then
  -- Mutated while we were projecting. It keeps its place in the queue and,
  -- with the lease released, is claimable again immediately.
  return 0
end
redis.call('ZREM', KEYS[1], member)
redis.call('ZREM', KEYS[2], member)
return 1
`;

/**
 * Acknowledge the version that was projected, proving ownership with the
 * claim's lease token. Returns false when the session changed mid-projection —
 * or the claim changed hands — in which case it stays a candidate.
 */
export async function ackProjection(
  redis: Redis,
  tenantId: string,
  runId: string,
  version: number,
  leaseUntilMs: number,
): Promise<boolean> {
  const acked = await redis.eval(
    ACK_PROJECTION_LUA,
    3,
    StreamKeys.projectionCandidatesKey,
    StreamKeys.projectionOrderKey,
    StreamKeys.projectionLeasesKey,
    sessionCandidateMember(tenantId, runId),
    String(version),
    String(leaseUntilMs),
  );
  return Number(acked) === 1;
}

/** Drop a candidate outright, for sessions that can never be projected. */
export async function dropProjectionCandidate(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const member = sessionCandidateMember(tenantId, runId);
  await redis
    .pipeline()
    .zrem(StreamKeys.projectionCandidatesKey, member)
    .zrem(StreamKeys.projectionOrderKey, member)
    .zrem(StreamKeys.projectionLeasesKey, member)
    .exec();
}

const DROP_IF_VERSION_LUA = `
local lease = redis.call('ZSCORE', KEYS[3], ARGV[1])
if not lease or tonumber(lease) ~= tonumber(ARGV[3]) then
  return 0
end
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
if current and tonumber(current) ~= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

/**
 * Drop only if the claim is still this worker's and the version is still the
 * one that was claimed.
 *
 * Eviction decides from reads made outside any transaction, and its own
 * bookkeeping is a Postgres round trip — plenty of room for a resume to
 * rehydrate the session and re-arm the candidate in between, or for the lease
 * to expire and the claim to change hands. An unguarded drop throws that fresh
 * arm away, and nothing re-arms it: the session was just written, so no
 * further write is coming. Returns false when the candidate moved, in which
 * case it stays.
 */
export async function dropProjectionCandidateIfVersion(
  redis: Redis,
  tenantId: string,
  runId: string,
  version: number,
  leaseUntilMs: number,
): Promise<boolean> {
  const dropped = await redis.eval(
    DROP_IF_VERSION_LUA,
    3,
    StreamKeys.projectionCandidatesKey,
    StreamKeys.projectionOrderKey,
    StreamKeys.projectionLeasesKey,
    sessionCandidateMember(tenantId, runId),
    String(version),
    String(leaseUntilMs),
  );
  return Number(dropped) === 1;
}

/** Every candidate, claimed or not. */
export async function countProjectionCandidates(redis: Redis): Promise<number> {
  return redis.zcard(StreamKeys.projectionCandidatesKey);
}
