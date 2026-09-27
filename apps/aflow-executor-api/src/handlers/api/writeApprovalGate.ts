import { createHash } from 'node:crypto';
import type { Redis } from '@aflow/redis';
import { getWriteApprovalGrant } from '@aflow/redis';
import {
  effectiveWriteRiskTier,
  requiresWriteApproval,
  type SpaceWriteApprovalPolicy,
  type WriteApprovalRequestPayload,
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
  readonly request: WriteApprovalRequestPayload;

  constructor(request: WriteApprovalRequestPayload) {
    super(`Write approval required for ${request.method} ${request.apiId}/${request.endpointId}`);
    this.name = 'ApiWriteApprovalRequired';
    this.request = request;
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
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

const BODY_PREVIEW_MAX = 4000;
const REDACTED = '[redacted]';

// Keys whose values are secrets or high-sensitivity PII — never surfaced in the
// approval preview or persisted in the pause payload. Matched case-insensitively
// as a substring so `apiKey`, `x-api-key`, `clientSecret`, `access_token`, etc.
// all hit.
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'auth',
  'credential',
  'private',
  'ssn',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
  'pin',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Deep-copy `value` with the values of sensitive-looking keys replaced by
 * `[redacted]`. Structure and non-sensitive values are preserved so the
 * operator sees the shape and content of the call without the preview becoming
 * a place secrets get persisted or displayed.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}

function bodyPreview(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  // A raw string/Buffer body carries no key structure to redact selectively; a
  // structured body is redacted key-by-key. Never previews a secret value.
  const redacted =
    typeof body === 'string' || body instanceof Uint8Array
      ? '[binary or opaque body]'
      : redactSensitive(body);
  const s = typeof redacted === 'string' ? redacted : stableStringify(redacted);
  return s.length > BODY_PREVIEW_MAX ? `${s.slice(0, BODY_PREVIEW_MAX)}…` : s;
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

  const preview = bodyPreview(resolved.body);
  const label = endpoint.description?.slice(0, 500);
  const request: WriteApprovalRequestPayload = {
    kind: 'write_approval',
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
