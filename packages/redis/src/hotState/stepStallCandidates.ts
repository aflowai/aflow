import type { ChainableCommander, Redis } from 'ioredis';
import { StreamKeys, SNOOZE_OPERATION_ID, getSnoozeMaxMs } from '@aflow/schemas';
import type { SessionHotState, StepHotState } from './schemas.js';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * Sessions whose current step is SCHEDULED or STARTED, as one sorted set scored
 * by the earliest instant that step could stop having a completion path.
 *
 * The score decides when the stall watchdog *looks*; it never decides what it
 * finds. `classifyStepCompletionPath` reads the live executor in-flight key and
 * process availability at examination time and is the only thing that may
 * conclude a step is unreachable, so a score that is early costs one extra look
 * and a score that is late is the only real failure — which is why every
 * estimate below is a lower bound.
 *
 * Reading is non-destructive. A due candidate that turns out to be healthy is
 * pushed forward, one that no longer matches the shape is dropped, and one that
 * is reaped is removed by the state write that reaps it. Nothing is leased,
 * because a session belongs to exactly one shard owner and that owner's cycles
 * do not overlap — so an instance that dies mid-sweep leaves its candidates
 * exactly where the next owner finds them, and an instance that does not own a
 * session can skip it without having hidden it from the one that does.
 *
 * Members are sessions rather than steps because that is the fact both readers
 * start from, and because a run can leave the active set with no step write at
 * all: a control-message failure and `failRun` both drive the session terminal
 * while a live SCHEDULED step keeps its hash. A session-keyed member lets the
 * session write clear it, so the step clear and the session clear are two
 * independent derivations and either one alone is enough.
 */

/** How often the watchdog re-examines a candidate that is still healthy. */
export const STEP_STALL_SCAN_INTERVAL_MS = 30_000;

/** Pickup grace for a SCHEDULED step while an executor for its type is alive. */
export const STEP_SCHEDULED_STALL_GRACE_MS = 3 * 60_000;

/** Grace for a STARTED step whose owning executor has gone silent. */
export const STEP_STARTED_DEAD_EXECUTOR_GRACE_MS = 10_000;

/** Pickup grace for a SCHEDULED step with no executor alive for its type. */
export const STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS = 10_000;

/**
 * A STARTED step's reap deadline is the executor's own effective timeout (carried
 * on the per-step in-flight key), not a flat clock. This margin is the slack past
 * that deadline before the orchestrator force-reaps a "zombie" executor — a live
 * process whose own withTimeout should already have emitted a result. Sized to
 * cover result emission + stream/network latency, not to bound op duration.
 */
export const STEP_DEADLINE_BACKSTOP_MS = 60_000;

export interface StepStallCandidate {
  tenantId: string;
  sessionId: string;
  /** The score the candidate was armed or refreshed with. */
  dueAtMs: number;
}

/**
 * The earliest instant at which this step could have no completion path, or
 * null when its status puts it outside the watchdog's shape entirely.
 *
 * Deliberately the *smallest* of the graces that could apply, because which one
 * does apply depends on executor liveness that is not known at write time: a
 * SCHEDULED step gets the dead-executor floor even when an executor is alive,
 * since the executor can die at any point and the grace then drops to that
 * floor retroactively. The snooze window is additive rather than an override —
 * a snoozing step's timer is its completion path for the whole window.
 *
 * Tolerates a partial patch: a caller that flips only `status` supplies no
 * timestamps, and `nowMs` is then the reference. That is a lower bound too —
 * the real transition happened at or before now.
 */
export function stepStallEarliestReapAtMs(
  step: Partial<StepHotState>,
  nowMs: number,
): number | null {
  if (step.status === 'STARTED') {
    return (step.startedAt ?? step.scheduledAt ?? nowMs) + STEP_STARTED_DEAD_EXECUTOR_GRACE_MS;
  }
  if (step.status !== 'SCHEDULED') return null;
  const snoozeWindowMs = step.operationId === SNOOZE_OPERATION_ID ? getSnoozeMaxMs() : 0;
  return (step.scheduledAt ?? nowMs) + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS + snoozeWindowMs;
}

/**
 * When to look at a candidate that was just examined and found healthy.
 *
 * A scan interval away, or the earliest instant it could be reapable, whichever
 * is later. The interval floor is what stops a step past its own lower bound
 * but still held by a live executor from being re-read on every cycle; the
 * lower bound is what lets a snoozing step sleep for its whole window instead,
 * since nothing that happens inside it can make the step reapable.
 */
export function stepStallNextCheckAtMs(step: StepHotState, nowMs: number): number {
  const earliest = stepStallEarliestReapAtMs(step, nowMs) ?? nowMs;
  return Math.max(earliest, nowMs + STEP_STALL_SCAN_INTERVAL_MS);
}

/**
 * Derive the candidate from a step write, inside the pipeline that write
 * already issues.
 *
 * A patch that carries no status says nothing about whether the step is in
 * flight, so it leaves the index alone.
 */
export function syncStepStallCandidateForStep(
  pipeline: ChainableCommander,
  tenantId: string,
  sessionId: string,
  step: Partial<StepHotState>,
  nowMs: number,
): void {
  if (step.status === undefined) return;
  const dueAtMs = stepStallEarliestReapAtMs(step, nowMs);
  // Arm only. The member is the session but the status is one step's, and a
  // session can hold several at once: in a parallel tool fan-out the first
  // sibling to finish would otherwise clear the session while the others are
  // still in flight, and nothing would arm it again. Clearing belongs to the
  // session rule, which knows the session is done, and to the readers, which
  // drop a candidate they find nothing in flight for.
  if (dueAtMs === null) return;
  pipeline.zadd(
    StreamKeys.stepStallCandidatesKey,
    dueAtMs,
    sessionCandidateMember(tenantId, sessionId),
  );
}

/**
 * Derive the candidate from a session write, inside the pipeline that write
 * already issues.
 *
 * Only ever clears. A session that is not RUNNING is skipped by both readers,
 * so its step cannot be a candidate whatever the step hash still says — and
 * that is the case the step write does not cover, because a run can be failed
 * or cancelled while its step keeps a SCHEDULED hash nobody rewrites. Arming
 * from here would be wrong in the other direction: a RUNNING session between
 * steps has nothing in flight.
 */
export function syncStepStallCandidateForSession(
  pipeline: ChainableCommander,
  tenantId: string,
  sessionId: string,
  status: SessionHotState['status'] | undefined,
): void {
  if (status === undefined || status === 'RUNNING') return;
  pipeline.zrem(StreamKeys.stepStallCandidatesKey, sessionCandidateMember(tenantId, sessionId));
}

/**
 * Candidates whose lower bound has passed, oldest first.
 *
 * Due-ordered, so a batch cap always takes the oldest work. A cap over an
 * unordered read leaves whichever entries come back last permanently
 * unexamined, and a stalled step can sit in that tail indefinitely.
 */
export async function peekDueStepStallCandidates(
  redis: Redis,
  limit: number,
  nowMs: number = Date.now(),
): Promise<StepStallCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.zrangebyscore(
    StreamKeys.stepStallCandidatesKey,
    '-inf',
    nowMs,
    'WITHSCORES',
    'LIMIT',
    0,
    limit,
  );

  const out: StepStallCandidate[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const parsed = parseSessionCandidateMember(String(raw[i]));
    if (parsed) out.push({ ...parsed, dueAtMs: Number(raw[i + 1]) });
  }
  return out;
}

/**
 * Push a still-healthy candidate forward. `XX` so a state write that cleared it
 * between the peek and here is not undone — a resurrected member would make the
 * watchdog re-read a session that has already moved on, every cycle, forever.
 */
export async function refreshStepStallCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  dueAtMs: number,
): Promise<void> {
  await redis.zadd(
    StreamKeys.stepStallCandidatesKey,
    'XX',
    dueAtMs,
    sessionCandidateMember(tenantId, sessionId),
  );
}

/**
 * Remove a candidate outright, for a session whose keys are being purged.
 *
 * Unconditional, unlike the readers' drop: there is no score to have raced
 * against because the session itself is going away.
 */
export async function purgeStepStallCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.zrem(StreamKeys.stepStallCandidatesKey, sessionCandidateMember(tenantId, sessionId));
}

const DROP_IF_UNCHANGED_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

/**
 * Drop a candidate whose session or step no longer matches the shape — a hash
 * that expired, a session deleted out of band, a step that parked.
 *
 * Compare-and-remove against the score the peek returned. The decision to drop
 * is made from a session and step read outside any transaction, so a write can
 * land in that gap: a session resuming re-arms the member, and an unconditional
 * ZREM would delete that fresh arm and leave a live step with no candidate and
 * nothing left to re-arm it.
 */
export async function dropStepStallCandidate(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  dueAtMs: number,
): Promise<boolean> {
  const dropped = await redis.eval(
    DROP_IF_UNCHANGED_LUA,
    1,
    StreamKeys.stepStallCandidatesKey,
    sessionCandidateMember(tenantId, sessionId),
    String(dueAtMs),
  );
  return Number(dropped) === 1;
}
