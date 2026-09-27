import type { Redis } from 'ioredis';
import { StreamKeys, RunAccessGrantSchema, type RunAccessGrant } from '@aflow/schemas';
// ============================================================================

/**
 * The grant's lifetime is `grant.expiresAt`, enforced by `enforceGrant` — never
 * a Redis key TTL. A key that expires turns a *renewable* grant into a *missing*
 * one, and the two are not interchangeable: the scheduler can re-compile an
 * expired grant from its own metadata, but a missing grant carries nothing to
 * re-compile from and fails the run closed. So the grant lives in exactly one
 * place, the session hot-state hash, and shares that hash's lifetime.
 */
export const RUN_ACCESS_GRANT_FIELD = 'grantJson';

/** Serialize a grant for the hot-state hash so writers can embed it in their own write. */
export function serializeRunAccessGrant(grant: RunAccessGrant): string {
  return JSON.stringify(grant);
}

/** Read a serialized grant off hot state, or null if unparseable. */
export function parseRunAccessGrant(raw: string): RunAccessGrant | null {
  try {
    return RunAccessGrantSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Get the RunAccessGrant for a run, or null if absent/unparseable. */
export async function getRunAccessGrant(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<RunAccessGrant | null> {
  const raw = await redis.hget(StreamKeys.sessionStateKey(tenantId, runId), RUN_ACCESS_GRANT_FIELD);
  if (!raw) return null;
  return parseRunAccessGrant(raw);
}

/**
 * Store a RunAccessGrant on an existing session hot state.
 *
 * Only safe once the hash exists. A caller that also *creates* the hash must
 * embed `grantJson` in that same write instead — `atomicCreateSession` and
 * `setSessionState` both DEL before HSET, so a grant written ahead of them is
 * discarded.
 */
export async function setRunAccessGrant(
  redis: Redis,
  tenantId: string,
  runId: string,
  grant: RunAccessGrant,
): Promise<void> {
  await redis.hset(
    StreamKeys.sessionStateKey(tenantId, runId),
    RUN_ACCESS_GRANT_FIELD,
    serializeRunAccessGrant(grant),
  );
}
