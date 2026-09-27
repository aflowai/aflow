import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys, SESSION_METADATA_DEBOUNCE_MS } from '@aflow/schemas';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * Conversations owed a title or a summary refresh.
 *
 * Three keys, for the same three facts the projection index keeps apart:
 *
 * - `candidates` — the evidence revision. A monotonic count of committed turn
 *   boundaries, acknowledged by value so a boundary landing mid-generation is
 *   not swallowed by the acknowledgement of the one before it.
 * - `due` — the earliest instant this conversation may be generated. Debounce,
 *   refresh floor, and retry backoff are all this one number, stamped from
 *   Redis so it is comparable against Redis' own clock.
 * - `leases` — when a claim expires. Recovery is the absence of a renewal: a
 *   worker that dies mid-generation blocks nobody past expiry.
 *
 * A fourth, `attempts`, is a plain hash holding only the candidates that have
 * failed at least once, so a conversation whose generation keeps dying retires
 * instead of retrying forever.
 */

export interface SessionMetadataCandidate {
  tenantId: string;
  sessionId: string;
  /** Hand back to `settleSessionMetadata` — the revision this claim covers. */
  evidenceRevision: number;
  /**
   * The claim's lease deadline, doubling as its ownership token. Successive
   * claims of one member are separated by the lease window, so no two share
   * this value and a worker resuming past its own lease cannot settle work
   * that now belongs to a successor.
   */
  leaseUntilMs: number;
  /** Consecutive failures so far. Zero on a first attempt. */
  attempts: number;
}

/**
 * How long a claim holds a candidate. Generous enough for a slow provider
 * round trip plus the evidence read either side of it, short enough that a
 * killed worker's conversations are named within a couple of cycles.
 */
export const SESSION_METADATA_CLAIM_LEASE_MS = 120_000;

/**
 * Arm a conversation for a metadata refresh, inside the pipeline the session
 * write already issues.
 *
 * Derived from one field — `lastActivityAt` on the patch — which is exactly
 * the signal wanted: the activity clock advances only on a committed
 * conversational boundary, so a Runner grinding through a skill's tasks, a
 * scheduled job, and a projection flush all leave this untouched without
 * anyone maintaining a list of what to exclude.
 *
 * `NX` holds a conversation's place at its FIRST unhandled boundary. A room
 * being typed in can therefore neither push its own name out indefinitely nor
 * jump the queue, and the answer that lands half a second after the request
 * joins the same generation rather than starting a second one. It also leaves
 * a refresh floor a settle wrote in the future exactly where it is.
 *
 * The due score is stamped by the caller, like every other index armed from
 * inside a producer's pipeline — asking Redis for its clock first would be the
 * round trip the budget forbids. Skew therefore shifts the debounce by however
 * far the clocks differ, which is harmless: the debounce is an optimization,
 * and the refresh floor that actually governs cost is re-derived from stored
 * state at claim time.
 *
 * This is the ONLY way a conversation becomes a metadata candidate; a guard
 * test fails if the keys are written anywhere else.
 */
export function syncSessionMetadataCandidate(
  pipeline: ChainableCommander,
  tenantId: string,
  sessionId: string,
  lastActivityAt: number | undefined,
  nowMs: number,
): void {
  if (lastActivityAt === undefined) return;
  const member = sessionCandidateMember(tenantId, sessionId);
  pipeline.zincrby(StreamKeys.sessionMetadataCandidatesKey, 1, member);
  pipeline.zadd(
    StreamKeys.sessionMetadataDueKey,
    'NX',
    nowMs + SESSION_METADATA_DEBOUNCE_MS,
    member,
  );
}

const NOW_MS_LUA = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

const CLAIM_LUA = `
${NOW_MS_LUA}
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', nowMs)

local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', nowMs, 'LIMIT', 0, limit + redis.call('ZCARD', KEYS[3]))
local leaseUntil = nowMs + leaseMs
local out = { leaseUntil }
local taken = 0
for i = 1, #due do
  if taken >= limit then break end
  local member = due[i]
  if redis.call('ZSCORE', KEYS[3], member) == false then
    local revision = redis.call('ZSCORE', KEYS[1], member)
    if revision then
      redis.call('ZADD', KEYS[3], leaseUntil, member)
      out[#out + 1] = member
      out[#out + 1] = revision
      out[#out + 1] = redis.call('HGET', KEYS[4], member) or '0'
      taken = taken + 1
    else
      -- Due with no revision is not a candidate: drop it rather than hand the
      -- worker something it can never settle.
      redis.call('ZREM', KEYS[2], member)
      redis.call('HDEL', KEYS[4], member)
    end
  end
end
return out
`;

/**
 * Claim up to `limit` conversations whose due time has passed, holding each for
 * the lease window.
 *
 * Bounded by design: the read asks for the due prefix plus however many claims
 * are in flight, so its cost tracks pending work rather than how many
 * conversations exist.
 */
export async function claimSessionMetadataCandidates(
  redis: Redis,
  limit: number,
  leaseMs: number = SESSION_METADATA_CLAIM_LEASE_MS,
): Promise<SessionMetadataCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.eval(
    CLAIM_LUA,
    4,
    StreamKeys.sessionMetadataCandidatesKey,
    StreamKeys.sessionMetadataDueKey,
    StreamKeys.sessionMetadataLeasesKey,
    StreamKeys.sessionMetadataAttemptsKey,
    String(limit),
    String(leaseMs),
  );
  if (!Array.isArray(raw)) return [];
  const leaseUntilMs = Number(raw[0]);
  const out: SessionMetadataCandidate[] = [];
  for (let i = 1; i + 2 < raw.length; i += 3) {
    const parsed = parseSessionCandidateMember(String(raw[i]));
    if (!parsed) continue;
    out.push({
      tenantId: parsed.tenantId,
      sessionId: parsed.sessionId,
      evidenceRevision: Number(raw[i + 1]),
      leaseUntilMs,
      attempts: Number(raw[i + 2]),
    });
  }
  return out;
}

/**
 * `done` — the revision is covered; drop it unless newer evidence arrived
 * while the model was answering, in which case it stays due after the floor.
 * `retry` — the attempt failed; count it and come back after the backoff.
 * `release` — nothing was attempted; hand it back, optionally after a delay.
 * `retire` — this conversation is not to be attempted again until it moves.
 */
export type SessionMetadataOutcome = 'done' | 'retry' | 'release' | 'retire';

const SETTLE_LUA = `
${NOW_MS_LUA}
local member = ARGV[1]
local outcome = ARGV[2]
local ackedRevision = tonumber(ARGV[3])
local leaseToken = tonumber(ARGV[4])
local nextDelayMs = tonumber(ARGV[5])

-- Ownership first. The revision alone cannot prove it: settling deletes the
-- counter and a re-armed member restarts at one, so a worker resuming past its
-- lease would see its stale revision match a fresh arm and consume it.
local lease = redis.call('ZSCORE', KEYS[3], member)
if not lease or tonumber(lease) ~= leaseToken then
  return 0
end
redis.call('ZREM', KEYS[3], member)

if outcome == 'retry' then
  redis.call('HINCRBY', KEYS[4], member, 1)
  redis.call('ZADD', KEYS[2], nowMs + nextDelayMs, member)
  return 1
end

if outcome == 'release' then
  -- Nothing was attempted, so nothing is owed a backoff and nothing counts
  -- against the failure budget: a cycle out of budget, or one that found the
  -- evidence not yet readable, has learned nothing about this conversation.
  -- A delay is optional; zero leaves it exactly as due as it was.
  if nextDelayMs > 0 then
    redis.call('ZADD', KEYS[2], nowMs + nextDelayMs, member)
  end
  return 1
end

redis.call('HDEL', KEYS[4], member)

if outcome == 'retire' then
  redis.call('ZREM', KEYS[1], member)
  redis.call('ZREM', KEYS[2], member)
  return 1
end

local current = redis.call('ZSCORE', KEYS[1], member)
if current and tonumber(current) > ackedRevision then
  -- Someone spoke while this was generating. What was produced still covers
  -- the revision it read; the conversation simply owes another pass, after the
  -- floor so a busy room refreshes at that rate rather than per message.
  redis.call('ZADD', KEYS[2], nowMs + nextDelayMs, member)
  return 2
end

redis.call('ZREM', KEYS[1], member)
redis.call('ZREM', KEYS[2], member)
return 1
`;

export interface SettleSessionMetadataResult {
  /** False when the claim had already changed hands — the caller owns nothing. */
  owned: boolean;
  /** True when newer evidence arrived mid-generation and a refresh is still due. */
  superseded: boolean;
}

/**
 * Release the claim and record what became of it, proving ownership with the
 * lease token the claim carried.
 */
export async function settleSessionMetadata(
  redis: Redis,
  candidate: Pick<SessionMetadataCandidate, 'tenantId' | 'sessionId' | 'leaseUntilMs'>,
  outcome: SessionMetadataOutcome,
  ackedRevision: number,
  nextDelayMs: number,
): Promise<SettleSessionMetadataResult> {
  const result = await redis.eval(
    SETTLE_LUA,
    4,
    StreamKeys.sessionMetadataCandidatesKey,
    StreamKeys.sessionMetadataDueKey,
    StreamKeys.sessionMetadataLeasesKey,
    StreamKeys.sessionMetadataAttemptsKey,
    sessionCandidateMember(candidate.tenantId, candidate.sessionId),
    outcome,
    String(ackedRevision),
    String(candidate.leaseUntilMs),
    String(nextDelayMs),
  );
  const code = Number(result);
  return { owned: code !== 0, superseded: code === 2 };
}

const REQUEST_NOW_LUA = `
${NOW_MS_LUA}
local member = ARGV[1]
redis.call('ZINCRBY', KEYS[1], 1, member)
redis.call('ZADD', KEYS[2], nowMs, member)
redis.call('HDEL', KEYS[3], member)
return 1
`;

/**
 * Make a conversation due now, whatever its refresh floor said.
 *
 * The explicit-regenerate path, and the only one that may overrule the floor —
 * a person asked, and a person asking is not the churn the floor exists to
 * prevent. Arms the revision too, so a conversation whose metadata is already
 * current still has something to acknowledge, and clears the failure count
 * because a retry someone asked for starts over.
 *
 * Stamped from Redis' own clock and not the caller's: the claim compares
 * against the server clock, so a caller a millisecond ahead would have its own
 * "due now" judged not yet due.
 */
export async function requestSessionMetadataNow(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.eval(
    REQUEST_NOW_LUA,
    3,
    StreamKeys.sessionMetadataCandidatesKey,
    StreamKeys.sessionMetadataDueKey,
    StreamKeys.sessionMetadataAttemptsKey,
    sessionCandidateMember(tenantId, sessionId),
  );
}

/**
 * Whether this worker still holds the lease it claimed.
 *
 * Generation outlives its own lease when a provider stalls, and the claim that
 * replaced it may already have written a newer name from newer evidence. The
 * durable write is keyed on the session alone, so a late worker would overwrite
 * that with the older one and — for a title, which freezes once established —
 * leave the wrong name in place permanently. Asked immediately before the
 * write, so the gap between the answer and the write is a round trip rather
 * than a model call.
 *
 * Not fenced on the evidence revision: settling deletes the counter and a
 * re-armed conversation restarts at one, so a monotonic revision test would
 * refuse every legitimate write after the first.
 */
export async function sessionMetadataLeaseHeld(
  redis: Redis,
  candidate: Pick<SessionMetadataCandidate, 'tenantId' | 'sessionId' | 'leaseUntilMs'>,
): Promise<boolean> {
  const lease = await redis.zscore(
    StreamKeys.sessionMetadataLeasesKey,
    sessionCandidateMember(candidate.tenantId, candidate.sessionId),
  );
  return lease !== null && Number(lease) === candidate.leaseUntilMs;
}

/** Forget a conversation entirely — deletion, and nothing else. */
export async function dropSessionMetadataCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  const member = sessionCandidateMember(tenantId, sessionId);
  await redis
    .pipeline()
    .zrem(StreamKeys.sessionMetadataCandidatesKey, member)
    .zrem(StreamKeys.sessionMetadataDueKey, member)
    .zrem(StreamKeys.sessionMetadataLeasesKey, member)
    .hdel(StreamKeys.sessionMetadataAttemptsKey, member)
    .exec();
}

/** Every candidate, claimed or not. */
export async function countSessionMetadataCandidates(redis: Redis): Promise<number> {
  return redis.zcard(StreamKeys.sessionMetadataCandidatesKey);
}
