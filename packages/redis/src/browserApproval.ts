import type { Redis } from 'ioredis';
import {
  stableHash,
  WRITE_APPROVAL_GRANT_TTL_SECONDS,
  type WriteApprovalGrant,
} from '@aflow/schemas';

/**
 * What the host executor keeps beside a browser action's approval (Plan 320
 * D7). The grant itself is the write-approval grant, minted only at the
 * authenticated resolve boundary; the host identity reads it and cannot write
 * it. These two records are what the host does write, and neither can approve
 * anything:
 *
 * - the **ask** — which request a call was parked on, keyed by the call as the
 *   agent made it (its page, element reference, action and value), so the
 *   fresh dispatch after an approval can find the approval even when the page
 *   has changed underneath it and the request it would make now hashes
 *   differently;
 * - the **spend** — set once, by the action an approval lets through, so an
 *   approval performs one action. Keyed by the grant's own decision time, so
 *   a later approval of the same request is a new grant to spend.
 */
export function browserAskKey(tenantId: string, runId: string, callKey: string): string {
  return `aflow:browser-ask:call:${tenantId}:${runId}:${callKey}`;
}

export function browserApprovalSpentKey(
  tenantId: string,
  runId: string,
  grant: Pick<WriteApprovalGrant, 'requestHash' | 'decidedAt'>,
): string {
  const decision = stableHash({ requestHash: grant.requestHash, decidedAt: grant.decidedAt ?? '' });
  return `aflow:browser-ask:spent:${tenantId}:${runId}:${decision}`;
}

export async function rememberBrowserAsk(
  redis: Redis,
  tenantId: string,
  runId: string,
  callKey: string,
  requestHash: string,
): Promise<void> {
  await redis.set(
    browserAskKey(tenantId, runId, callKey),
    requestHash,
    'EX',
    WRITE_APPROVAL_GRANT_TTL_SECONDS,
  );
}

export async function readBrowserAsk(
  redis: Redis,
  tenantId: string,
  runId: string,
  callKey: string,
): Promise<string | null> {
  return await redis.get(browserAskKey(tenantId, runId, callKey));
}

/**
 * Spends an approval. True for the one caller that spent it; false when it was
 * spent already. Outlives the grant it marks, so a spent grant never reads as
 * fresh again.
 */
export async function spendBrowserApproval(
  redis: Redis,
  tenantId: string,
  runId: string,
  grant: Pick<WriteApprovalGrant, 'requestHash' | 'decidedAt'>,
): Promise<boolean> {
  const set = await redis.set(
    browserApprovalSpentKey(tenantId, runId, grant),
    '1',
    'EX',
    WRITE_APPROVAL_GRANT_TTL_SECONDS,
    'NX',
  );
  return set === 'OK';
}
