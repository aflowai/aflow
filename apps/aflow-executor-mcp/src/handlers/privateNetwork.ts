/**
 * The MCP executor's side of Plan 336: which private network policy a managed
 * connect runs under, and what a refused connect tells the step error.
 */
import {
  DEFAULT_PRIVATE_NETWORK_POLICY,
  DnsBlockedError,
  describeRangeLabel,
  type PrivateNetworkPolicy,
  type SsrfBlockedError,
} from '@aflow/network-safety';
import { validationError } from '@aflow/executor-runtime';
import {
  describeMcpEgressRefusal,
  type AflowError,
  type McpEgressRefusalDetails,
} from '@aflow/schemas';
import { getMcpSpaceStores, type McpHandlerStores } from './types.js';

/** The ceiling `AflowErrorSchema` puts on a message. */
const MESSAGE_MAX_CHARS = 1000;

/**
 * The policy the space loader built for this definition (D3), or the default
 * when the server is unknown. The raw `serverUrl` path never asks, because an
 * agent chose that URL (D1).
 */
export function privateNetworkPolicyOf(
  stores: McpHandlerStores,
  ref: { tenantId: string; spaceId: string; serverId: string } | null,
): PrivateNetworkPolicy {
  if (ref === null) return DEFAULT_PRIVATE_NETWORK_POLICY;
  return (
    getMcpSpaceStores(stores, ref.tenantId, ref.spaceId).privateNetworkStore.get(ref.serverId) ??
    DEFAULT_PRIVATE_NETWORK_POLICY
  );
}

/**
 * What a refused connect names on the step error: the kind, the range in words
 * and as its label, the refused target and what the operator can do about it
 * (D6). The label is carried, never compared, so the decision stays in
 * `@aflow/network-safety`.
 */
export function egressRefusalDetails(
  err: SsrfBlockedError | DnsBlockedError,
): McpEgressRefusalDetails {
  if (err instanceof DnsBlockedError) return { kind: err.kind, target: err.hostname };
  return {
    kind: err.kind,
    target: err.kind === 'invalid-protocol' ? hostOf(err.target) : err.target,
    ...(err.rangeLabel
      ? { rangeLabel: err.rangeLabel, range: describeRangeLabel(err.rangeLabel) }
      : {}),
    ...(err.remedy ? { remedy: err.remedy } : {}),
  };
}

/**
 * `validateUrl` and `validateCredentialedUrl` name the raw URL on a protocol
 * refusal. The details name the host the policy judges.
 */
function hostOf(target: string): string {
  try {
    return new URL(target).hostname || target;
  } catch {
    return target;
  }
}

/** The step error a refused managed connect fails with: its message and its details. */
export function egressRefusalError(
  err: SsrfBlockedError | DnsBlockedError,
  serverName: string,
  stores: McpHandlerStores,
  ref: { tenantId: string; spaceId: string; serverId: string },
): AflowError {
  const policy = privateNetworkPolicyOf(stores, ref);
  return validationError(egressRefusalMessage(err, serverName, policy), egressRefusalDetails(err));
}

/**
 * The refusal's message with its remedy in words, because the Helmsman reads
 * the message on its next turn. The words are the ones the integration card
 * shows, from `describeMcpEgressRefusal`.
 */
export function egressRefusalMessage(
  err: SsrfBlockedError | DnsBlockedError,
  serverName: string,
  policy: PrivateNetworkPolicy,
): string {
  const remedy = describeMcpEgressRefusal(egressRefusalDetails(err), {
    serverName,
    acknowledged: policy.hosts.length > 0 || policy.withheld.length > 0,
  });
  return (remedy === null ? err.message : `${err.message} ${remedy}`).slice(0, MESSAGE_MAX_CHARS);
}
