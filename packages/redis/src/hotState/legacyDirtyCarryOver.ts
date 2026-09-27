import type { Redis } from 'ioredis';
import { getSessionState } from './session.js';
import { getStepState } from './step.js';
import { markProjectionCandidate } from './projectionCandidates.js';
import { syncQueuedSessionCandidate } from './queuedSessionCandidates.js';
import { syncStepStallCandidateForStep } from './stepStallCandidates.js';
import { syncDelegationSupervisionCandidate } from './delegationSupervisionCandidates.js';
import { sessionCandidateMember, parseSessionCandidateMember } from './candidateMember.js';

/**
 * The set every session used to be registered in, before candidate indexes
 * replaced it. Read once at boot to carry the sessions in it across the
 * release, then deleted. No writer remains.
 */
const LEGACY_DIRTY_SESSIONS_KEY = 'aflow:dirty:sessions';

export interface LegacyDirtyCarryOver {
  projection: number;
  queued: number;
  stalled: number;
  waiting: number;
}

/**
 * Move the sessions the previous release left behind into the candidate indexes.
 *
 * The indexes are armed only by a write to session or step state, which
 * makes them complete for everything that happens *after* they exist and blind
 * to everything already in flight when they appear. A run that failed seconds
 * before the deploy is terminal: nothing will write its state again, so nothing
 * will arm it, and its durable record is simply never written. A run mid-step is
 * worse — it needs no further write either, because the executor holding it died
 * with the deploy, so the watchdogs that exist to catch exactly that never see
 * it.
 *
 * Shard recovery does not cover this. `recoverRun` returns early when the
 * session hash is still in Redis, which is the ordinary case on a rolling
 * restart, so it rewrites nothing and therefore arms nothing.
 *
 * The legacy set is the right source because of what it happened to contain: it
 * was written on every session and step transition and cleared only at a
 * terminal flush, so it holds a superset of every session that is queued,
 * running, or awaiting projection.
 *
 * A full read of the set, deliberately — bounded by the live population at
 * deploy time, run once, and deleted with the key it reads.
 */
export async function carryOverLegacyDirtySessions(redis: Redis): Promise<LegacyDirtyCarryOver> {
  const members = await redis.smembers(LEGACY_DIRTY_SESSIONS_KEY);
  const carried: LegacyDirtyCarryOver = { projection: 0, queued: 0, stalled: 0, waiting: 0 };
  if (members.length === 0) return carried;

  const nowMs = Date.now();
  for (const member of members) {
    const parsed = parseSessionCandidateMember(member);
    if (!parsed) continue;
    const { tenantId, sessionId } = parsed;

    const pipeline = redis.pipeline();
    // Unconditional: membership meant "not yet flushed to rest", and a session
    // whose hot state has already expired still needs whatever it last wrote.
    markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, sessionId));
    carried.projection++;

    const session = await getSessionState(redis, tenantId, sessionId);
    if (session) {
      syncQueuedSessionCandidate(
        pipeline,
        tenantId,
        sessionId,
        session.status,
        session.createdAt,
        nowMs,
      );
      if (session.status === 'QUEUED') carried.queued++;

      syncDelegationSupervisionCandidate(pipeline, tenantId, sessionId, session.status, nowMs);
      if (session.status === 'WAITING_ON_CHILD') carried.waiting++;

      if (session.status === 'RUNNING' && session.currentStepExecutionId) {
        const step = await getStepState(redis, tenantId, session.currentStepExecutionId);
        if (step) {
          syncStepStallCandidateForStep(pipeline, tenantId, sessionId, step, nowMs);
          carried.stalled++;
        }
      }
    }

    await pipeline.exec();
  }

  // Only after every member is carried, so an interrupted pass retries in full
  // on the next boot rather than losing whatever it had not reached.
  await redis.del(LEGACY_DIRTY_SESSIONS_KEY);
  return carried;
}
