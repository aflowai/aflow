import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import type { SessionHotState } from './schemas.js';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * Sessions sitting in QUEUED, as one sorted set scored by their creation time.
 *
 * The score is the fact, not the verdict: the run watchdog turns its own grace
 * period into a cutoff and claims everything created before it. Baking the
 * grace into the score would freeze one reader's tunable into data written by
 * three other services, and one of those services replays a creation timestamp
 * that can be arbitrarily old.
 *
 * Claiming leases rather than peeks, which is the difference from the
 * step-stall index next door: queued sessions are not sharded and the watchdog
 * runs on every warm server instance, so without a single winner N instances
 * each write the same STALLED transition and emit N identical events. A lease
 * also means a claimant that dies before writing leaves the session to be
 * stalled by the next cycle rather than losing it.
 */

/**
 * How long a claim holds a queued session before another instance may take it.
 *
 * Comfortably longer than the transition it guards (one state write, one event
 * append) and short enough that a killed instance's claims come back inside a
 * few watchdog cycles.
 */
export const QUEUED_SESSION_CLAIM_LEASE_MS = 60_000;

export interface QueuedSessionCandidate {
  tenantId: string;
  sessionId: string;
}

/**
 * Derive the candidate from a session write, inside the pipeline that write
 * already issues.
 *
 * QUEUED arms, every other status clears, and a patch that carries no status
 * leaves the index alone. Deriving it here rather than at the call sites is
 * what makes it complete: sessions are created QUEUED by three different
 * services and leave QUEUED through nine distinct transitions across two write
 * primitives, and no enumeration of those maintained by hand stays true.
 */
export function syncQueuedSessionCandidate(
  pipeline: ChainableCommander,
  tenantId: string,
  sessionId: string,
  status: SessionHotState['status'] | undefined,
  createdAtMs: number | undefined,
  nowMs: number,
): void {
  if (status === undefined) return;
  const member = sessionCandidateMember(tenantId, sessionId);
  if (status === 'QUEUED') {
    pipeline.zadd(StreamKeys.queuedSessionCandidatesKey, createdAtMs ?? nowMs, member);
  } else {
    pipeline.zrem(StreamKeys.queuedSessionCandidatesKey, member);
  }
}

/**
 * Scores are stamped from Redis' clock, never the caller's: the lease is
 * compared between server instances, and a few seconds of skew is enough for
 * one to treat another's live claim as expired.
 */
const CLAIM_QUEUED_LUA = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due == 0 then return {} end

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local leaseUntil = nowMs + tonumber(ARGV[3])
for i = 1, #due do
  redis.call('ZADD', KEYS[1], leaseUntil, due[i])
end
return due
`;

/**
 * Claim up to `limit` sessions created at or before `cutoffMs`, holding each
 * for the lease window.
 *
 * The reply carries only what is past the cutoff, so the cost tracks queued
 * work that has actually aged rather than how many sessions exist.
 */
export async function claimDueQueuedSessions(
  redis: Redis,
  cutoffMs: number,
  limit: number,
  leaseMs: number = QUEUED_SESSION_CLAIM_LEASE_MS,
): Promise<QueuedSessionCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.eval(
    CLAIM_QUEUED_LUA,
    1,
    StreamKeys.queuedSessionCandidatesKey,
    String(cutoffMs),
    String(limit),
    String(leaseMs),
  );
  if (!Array.isArray(raw)) return [];
  const out: QueuedSessionCandidate[] = [];
  for (const member of raw) {
    const parsed = parseSessionCandidateMember(String(member));
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Put a claimed session back at its true creation time — the repair for a score
 * left standing at a lease deadline by a claimant that died. `XX` so a session
 * that started while the claim was held is not resurrected.
 */
export async function rearmQueuedSessionCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  createdAtMs: number,
): Promise<void> {
  await redis.zadd(
    StreamKeys.queuedSessionCandidatesKey,
    'XX',
    createdAtMs,
    sessionCandidateMember(tenantId, sessionId),
  );
}

/**
 * Drop a candidate whose session hash is gone or is no longer QUEUED. Without
 * it a session deleted out of band leaves a member every cycle claims, reads,
 * and discards.
 */
export async function dropQueuedSessionCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.zrem(
    StreamKeys.queuedSessionCandidatesKey,
    sessionCandidateMember(tenantId, sessionId),
  );
}
