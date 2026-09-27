import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import type { SessionHotState } from './schemas.js';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * Parents blocked in WAITING_ON_CHILD, as one sorted set scored by when the
 * supervision sweep should next look at one.
 *
 * The delegation lifecycle is armed by a child *completing*. A child that dies
 * before it completes leaves its parent waiting with nothing armed anywhere and
 * no reader that could find it, so the wait itself has to be the marker. That is
 * the whole population this index exists for; a parent whose child is alive is
 * already covered by the child's own step-stall candidate, whose reaping routes
 * back through `failRun` and releases the parent.
 *
 * `status` is the fact, and deriving from it inside the session write primitives
 * is what makes the index complete: every enter and every exit of the wait
 * carries a status through `setSessionState`, `updateSessionState`, or the
 * atomic writers, and a patch that carries none leaves the index alone — which
 * is exactly right for the multi-child case, where releasing one sibling writes
 * delegation fields and no status while the others are still live.
 * `waitingForChildSessionIds` cannot be the fact: `addWaitingChild` and
 * `removeWaitingChild` HSET that field with their own Lua and reach none of the
 * primitives.
 *
 * There is no attempt counter here, deliberately. A pending entry's default
 * trajectory is escalation and the drain fabricates a FAILED once its attempts
 * run out; a supervision entry's healthy trajectory is "nothing to do, look
 * again later", indefinitely. Detection is all this index does — every action it
 * takes goes through the existing lifecycle, so escalation stays owned by one
 * place.
 *
 * Nothing is leased. A session belongs to exactly one shard owner whose cycles
 * do not overlap, so the sweep filters on ownership and reads non-destructively:
 * an instance that dies mid-sweep leaves its candidates where the next owner
 * finds them.
 */

/**
 * How long a waiting parent is left alone before the sweep looks at it, and how
 * far a still-healthy one is pushed forward.
 *
 * A domain constant, not a scheduling budget: it says how long the ordinary
 * completion path may take before a wait is worth a second look, which is a
 * property of the delegation rather than of how often the sweep runs.
 */
export const DELEGATION_SUPERVISION_CHECK_INTERVAL_MS = 60_000;

export interface DelegationSupervisionCandidate {
  tenantId: string;
  /** The waiting parent. */
  sessionId: string;
  /** The score the candidate was armed or refreshed with. */
  dueAtMs: number;
}

/**
 * Derive the candidate from a session write, inside the pipeline that write
 * already issues.
 *
 * WAITING_ON_CHILD arms, every other status clears, and a patch that carries no
 * status leaves the index alone.
 *
 * A parent parked at PAUSED to relay a child's question is cleared even though
 * it still tracks live children. That is deliberate: the parent is blocked on a
 * human, not on the child, and the human's answer re-enters the wait through
 * `leaveChildInputToWaiting`, which re-arms.
 */
export function syncDelegationSupervisionCandidate(
  pipeline: ChainableCommander,
  tenantId: string,
  sessionId: string,
  status: SessionHotState['status'] | undefined,
  nowMs: number,
): void {
  if (status === undefined) return;
  const member = sessionCandidateMember(tenantId, sessionId);
  if (status === 'WAITING_ON_CHILD') {
    pipeline.zadd(
      StreamKeys.delegationSupervisionCandidatesKey,
      nowMs + DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
      member,
    );
  } else {
    pipeline.zrem(StreamKeys.delegationSupervisionCandidatesKey, member);
  }
}

/**
 * Waiting parents whose next-check instant has passed, oldest first.
 *
 * Due-ordered, so a batch cap always takes the longest-unexamined wait. A cap
 * over an unordered read leaves whichever members come back last permanently
 * unexamined, and a wedged parent can sit in that tail forever.
 */
export async function peekDueDelegationSupervisionCandidates(
  redis: Redis,
  limit: number,
  nowMs: number = Date.now(),
): Promise<DelegationSupervisionCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.zrangebyscore(
    StreamKeys.delegationSupervisionCandidatesKey,
    '-inf',
    nowMs,
    'WITHSCORES',
    'LIMIT',
    0,
    limit,
  );

  const out: DelegationSupervisionCandidate[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const parsed = parseSessionCandidateMember(String(raw[i]));
    if (parsed) out.push({ ...parsed, dueAtMs: Number(raw[i + 1]) });
  }
  return out;
}

/**
 * Push a parent that is still legitimately waiting forward, consuming nothing.
 *
 * `XX` so a state write that released the parent between the peek and here is
 * not undone — a resurrected member would make the sweep re-read a session that
 * has already moved on, every cycle, forever.
 */
export async function refreshDelegationSupervisionCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  dueAtMs: number,
): Promise<void> {
  await redis.zadd(
    StreamKeys.delegationSupervisionCandidatesKey,
    'XX',
    dueAtMs,
    sessionCandidateMember(tenantId, sessionId),
  );
}

const DROP_IF_UNCHANGED_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/**
 * Drop a candidate whose parent is no longer waiting — a session released out of
 * band, or one whose hot state expired.
 *
 * Compare-and-remove against the score the peek returned: the decision is made
 * from a read outside any transaction, so a parent re-entering the wait in that
 * gap re-arms the member, and an unconditional ZREM would delete that fresh arm.
 */
export async function dropDelegationSupervisionCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  dueAtMs: number,
): Promise<boolean> {
  const dropped = await redis.eval(
    DROP_IF_UNCHANGED_LUA,
    1,
    StreamKeys.delegationSupervisionCandidatesKey,
    sessionCandidateMember(tenantId, sessionId),
    String(dueAtMs),
  );
  return Number(dropped) === 1;
}

/**
 * Remove a candidate outright, for a session whose keys are being purged.
 *
 * Unconditional, unlike the sweep's drop: there is no score to have raced
 * against because the session itself is going away.
 */
export async function purgeDelegationSupervisionCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.zrem(
    StreamKeys.delegationSupervisionCandidatesKey,
    sessionCandidateMember(tenantId, sessionId),
  );
}

/** Every waiting parent currently indexed. Operational metric only. */
export async function countDelegationSupervisionCandidates(redis: Redis): Promise<number> {
  return redis.zcard(StreamKeys.delegationSupervisionCandidatesKey);
}
