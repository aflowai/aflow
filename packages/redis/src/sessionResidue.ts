import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { dropProjectionCandidate } from './hotState/projectionCandidates.js';
import { dropQueuedSessionCandidate } from './hotState/queuedSessionCandidates.js';
import { dropSessionMetadataCandidate } from './hotState/sessionMetadataCandidates.js';
import { purgeStepStallCandidate } from './hotState/stepStallCandidates.js';
import { purgeDelegationSupervisionCandidate } from './hotState/delegationSupervisionCandidates.js';
import { deleteRecoveryData } from './recoveryStream.js';

export interface SessionResidueResult {
  keysCleared: number;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

/**
 * Clear every per-session Redis key a purged session leaves behind: hot state,
 * event stream, meta/corrupt/quarantine markers, presence, applet focus, HITL
 * gate scratch, recovery data, and every candidate index that names it.
 * Tolerant of absent keys — safe on rerun and on sessions that never populated
 * a surface.
 *
 * The index drops are not optional tidiness: a purged session that keeps a
 * candidate is claimed, read, and discarded on every cycle of the task that
 * owns it, forever, which is exactly the cardinality-proportional idle cost the
 * indexes exist to remove.
 */
export async function deleteSessionResidue(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<SessionResidueResult> {
  const fixedKeys = [
    StreamKeys.sessionStateKey(tenantId, sessionId),
    StreamKeys.sessionEventsStream(tenantId, sessionId),
    StreamKeys.sessionMetaKey(tenantId, sessionId),
    StreamKeys.sessionCorruptMarkerKey(tenantId, sessionId),
    StreamKeys.sessionPresenceKey(tenantId, sessionId),
    StreamKeys.sessionAppletFocusKey(tenantId, sessionId),
  ];

  // Keys with a per-request/per-user suffix — derived from the same builders
  // so the patterns cannot drift from the key shapes.
  const patterns = [
    StreamKeys.hitlGateCallInputKey(tenantId, sessionId, '*'),
    StreamKeys.hitlGateClearedKey(tenantId, sessionId, '*'),
    StreamKeys.sessionLastSeenKey(tenantId, sessionId, '*'),
    `${StreamKeys.sessionStateKey(tenantId, sessionId)}:corrupt:*`,
  ];
  const scannedKeys = (await Promise.all(patterns.map((p) => scanKeys(redis, p)))).flat();

  const keys = [...fixedKeys, ...scannedKeys];
  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.unlink(key);
  await pipeline.exec();

  await dropProjectionCandidate(redis, tenantId, sessionId);
  await dropQueuedSessionCandidate(redis, tenantId, sessionId);
  await dropSessionMetadataCandidate(redis, tenantId, sessionId);
  await purgeStepStallCandidate(redis, tenantId, sessionId);
  await purgeDelegationSupervisionCandidate(redis, tenantId, sessionId);
  await deleteRecoveryData(redis, tenantId, sessionId);

  return { keysCleared: keys.length };
}
