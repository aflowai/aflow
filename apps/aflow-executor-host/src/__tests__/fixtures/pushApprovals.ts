/**
 * Approval grants as the gate reads them, held in memory: none at all, or the
 * ones a test minted, keyed as Redis keys them — by tenant, run and request hash.
 */
import type { WriteApprovalGrant } from '@aflow/schemas';

import type { PushApprovalReader } from '../../scanReceipt.js';

export const noPushApprovals: PushApprovalReader = () => Promise.resolve(null);

export function pushApprovalsHolding(
  grants: ReadonlyMap<string, WriteApprovalGrant>,
): PushApprovalReader {
  return (tenantId, runId, requestHash) =>
    Promise.resolve(grants.get(`${tenantId}:${runId}:${requestHash}`) ?? null);
}
