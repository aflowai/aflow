import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { getSessionState } from './session.js';
import { syncDelegationSupervisionCandidate } from './delegationSupervisionCandidates.js';
import { parseSessionCandidateMember } from './candidateMember.js';

/**
 * Arm supervision for the parents that were already waiting when the index
 * first appeared.
 *
 * An index armed only by writes is complete for everything that happens after
 * it exists and blind to everything in flight when it does — and a waiting
 * parent is the worst case of that, because waiting is precisely the state in
 * which nothing writes its session again. Its next write is the release this
 * index exists to guarantee, so without a carry-over the population that most
 * needs supervision is the one that never gets it.
 *
 * The active-run set is the cursor: membership is written when a run starts and
 * cleared only on a terminal transition — pause and child-wait deliberately keep
 * it — so it holds every parent that could be waiting. A bounded full read of
 * it, run once at boot, the same read `reconcileActiveRuns` already performs.
 *
 * Nothing is deleted and nothing is cleared: a member whose session is not
 * waiting is simply skipped, so the pass is idempotent and safe to repeat on
 * every boot.
 */
export async function carryOverWaitingParents(redis: Redis): Promise<number> {
  const members = await redis.smembers(StreamKeys.activeRunsKey);
  if (members.length === 0) return 0;

  const nowMs = Date.now();
  let armed = 0;
  for (const member of members) {
    const parsed = parseSessionCandidateMember(member);
    if (!parsed) continue;
    const { tenantId, sessionId } = parsed;

    const session = await getSessionState(redis, tenantId, sessionId);
    if (session?.status !== 'WAITING_ON_CHILD') continue;

    const pipeline = redis.pipeline();
    syncDelegationSupervisionCandidate(pipeline, tenantId, sessionId, session.status, nowMs);
    await pipeline.exec();
    armed++;
  }
  return armed;
}
