import type { Redis } from 'ioredis';
import { WriteApprovalGrantSchema, type WriteApprovalGrant } from '@aflow/schemas';

/**
 * Write-approval grant (Plan 253). Written ONLY at the authenticated boundary —
 * the Action Center resolve handler, which holds the real actor identity — when
 * an operator approves or denies a gated write. The orchestrator reads it to
 * decide re-dispatch vs fail; the API executor reads it on re-dispatch to let
 * the call through. Keyed by `(tenantId, runId, requestHash)`, NOT by step
 * execution id — a re-dispatch mints a fresh execution id, and the approval is
 * bound to the exact call (requestHash) within the run regardless. No
 * non-authenticated resume (a scheduled `{}` wake, an agent-driven resume) can
 * mint this, so a resume that is not an explicit human decision cannot approve.
 * TTL-bounded: an unconsumed grant simply expires.
 */
const WRITE_APPROVAL_GRANT_TTL_SECONDS = 3600;

export function writeApprovalGrantKey(
  tenantId: string,
  runId: string,
  requestHash: string,
): string {
  return `aflow:write-approval:${tenantId}:${runId}:${requestHash}`;
}

export async function setWriteApprovalGrant(
  redis: Redis,
  tenantId: string,
  runId: string,
  grant: WriteApprovalGrant,
  ttlSeconds: number = WRITE_APPROVAL_GRANT_TTL_SECONDS,
): Promise<void> {
  await redis.set(
    writeApprovalGrantKey(tenantId, runId, grant.requestHash),
    JSON.stringify(grant),
    'EX',
    ttlSeconds,
  );
}

export async function getWriteApprovalGrant(
  redis: Redis,
  tenantId: string,
  runId: string,
  requestHash: string,
): Promise<WriteApprovalGrant | null> {
  const raw = await redis.get(writeApprovalGrantKey(tenantId, runId, requestHash));
  if (!raw) return null;
  try {
    return WriteApprovalGrantSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
