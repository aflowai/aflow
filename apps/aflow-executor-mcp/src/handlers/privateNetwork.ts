/**
 * The MCP executor's side of Plan 336: which private network policy a managed
 * connect runs under, and what a refused connect tells the step error.
 */
import {
  DEFAULT_PRIVATE_NETWORK_POLICY,
  DnsBlockedError,
  type PrivateNetworkPolicy,
  type SsrfBlockedError,
} from '@aflow/network-safety';
import { getMcpSpaceStores, type McpHandlerStores } from './types.js';

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
 * What a refused connect names on the step error: the kind, the range, the
 * refused target and what the operator can do about it (D6). The label is
 * carried, never compared, so the decision stays in `@aflow/network-safety`.
 */
export function egressRefusalDetails(
  err: SsrfBlockedError | DnsBlockedError,
): Record<string, unknown> {
  if (err instanceof DnsBlockedError) return { kind: err.kind, target: err.hostname };
  const details = {
    kind: err.kind,
    target: err.target,
    rangeLabel: err.rangeLabel,
    remedy: err.remedy,
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}
