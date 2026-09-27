import type { Redis } from 'ioredis';
import { markProjectionCandidate } from './projectionCandidates.js';
import { sessionCandidateMember } from './candidateMember.js';

/**
 * Mark a session as needing a Postgres projection, for writers that do not
 * already own a pipeline the arming can ride.
 */
export async function markSessionDirty(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const pipeline = redis.pipeline();
  markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, runId));
  await pipeline.exec();
}
