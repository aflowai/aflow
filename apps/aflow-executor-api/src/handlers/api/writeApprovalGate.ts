import { createHash } from 'node:crypto';
import type { Redis } from '@aflow/redis';
import { getWriteApprovalGrant } from '@aflow/redis';
import {
  effectiveWriteRiskTier,
  previewWrite,
  requiresWriteApproval,
  stableStringify,
  type SpaceWriteApprovalPolicy,
  type ApiWriteApprovalRequestPayload,
} from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { ResolvedCall } from './types.js';

/**
 * Thrown by the write-approval gate when a resolved call targets a gated write
 * endpoint and no matching approval is on record. The handler catches it and
 * parks the step as a `write_approval` PAUSE (Plan 253), mirroring the
 * `ApiOAuthConsentRequired` → `pausedWithRequest` path.
 */
export class ApiWriteApprovalRequired extends Error {
  readonly request: ApiWriteApprovalRequestPayload;

  constructor(request: ApiWriteApprovalRequestPayload) {
    super(`Write approval required for ${request.method} ${request.apiId}/${request.endpointId}`);
    this.name = 'ApiWriteApprovalRequired';
    this.request = request;
  }
}

/**
 * A stable fingerprint of the exact resolved call. An approval is bound to this
 * hash, so a later call that differs in method, URL, or body re-gates rather
 * than riding a stale approval.
 */
export function computeRequestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${url}\n${stableStringify(body)}`, 'utf8')
    .digest('hex');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Enforce the per-endpoint write-risk gate. Returns when the call may proceed;
 * throws `ApiWriteApprovalRequired` when it must pause for human approval.
 *
 * Endpoint-mode only — a direct-URL call carries no `endpoint` and is
 * pre-authorized by its operator-created binding, so it is never gated here.
 * The common path (read/low tier) returns after two pure checks with no IO;
 * only a gated (medium/high) call reads the approval grant.
 */
export async function enforceWriteApprovalGate(
  ctx: ExecutorContext,
  resolved: ResolvedCall,
  redis: Redis | undefined,
  policy?: SpaceWriteApprovalPolicy | null,
): Promise<void> {
  const endpoint = resolved.endpoint;
  if (!endpoint) return;

  const tier = effectiveWriteRiskTier(endpoint);
  if (!requiresWriteApproval(tier, policy)) return;

  const requestHash = computeRequestHash(resolved.method, resolved.url, resolved.body);

  if (redis) {
    const grant = await getWriteApprovalGrant(redis, ctx.tenantId, ctx.runId, requestHash);
    if (grant?.decision === 'approved' && grant.requestHash === requestHash) return;
  }

  const preview = previewWrite(resolved.body);
  const label = endpoint.description?.slice(0, 500);
  const request: ApiWriteApprovalRequestPayload = {
    kind: 'write_approval',
    target: 'api',
    apiId: resolved.apiId ?? endpoint.endpointId,
    endpointId: endpoint.endpointId,
    endpointName: endpoint.name,
    method: resolved.method,
    urlHost: hostOf(resolved.url),
    writeRiskTier: tier,
    requestHash,
    ...(label ? { operationLabel: label } : {}),
    ...(preview !== undefined ? { bodyPreview: preview } : {}),
    ...(ctx.job.credentialOwnerId ? { initiatedBy: ctx.job.credentialOwnerId } : {}),
  };
  throw new ApiWriteApprovalRequired(request);
}
