import type { Redis } from 'ioredis';
import {
  type HostApprovedPush,
  stableHash,
  WriteApprovalGrantSchema,
  type WriteApprovalGrant,
} from '@aflow/schemas';

/**
 * Write-approval grant (Plan 253). Written ONLY at the authenticated boundary —
 * the Action Center resolve handler, which holds the real actor identity — when
 * an operator approves or denies a gated write, and the operator's resolve of a
 * workflow human task whose previewed call is a host push. The orchestrator
 * reads it to decide re-dispatch vs fail; the API executor reads it on
 * re-dispatch to let the call through, and the host executor before a push its
 * gate does not clear alone. Keyed by `(tenantId, runId, requestHash)`, NOT by step
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

/**
 * The `requestHash` a host push's grant is keyed by: the push's folder, its one
 * refspec and the scan receipt it carries, and nothing else of its input. The
 * resolve boundary computes it over the `approvedCall` the operator decided,
 * and the host executor over the push it is about to spawn, so the two meet
 * only where the operator approved exactly that push.
 */
export function hostPushRequestHash(push: HostApprovedPush): string {
  return stableHash({
    op: 'host.process.exec',
    bindingId: push.bindingId,
    refspec: push.refspec,
    receipt: push.receipt,
  });
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
