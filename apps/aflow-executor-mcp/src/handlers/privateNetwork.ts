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
import type { McpEgressRefusalDetails } from '@aflow/schemas';
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
    target: err.target,
    ...(err.rangeLabel
      ? { rangeLabel: err.rangeLabel, range: describeRangeLabel(err.rangeLabel) }
      : {}),
    ...(err.remedy ? { remedy: err.remedy } : {}),
  };
}

/**
 * The refusal's message with its remedy in words, because the Helmsman reads
 * the message on its next turn. Each remedy names where the operator acts. The
 * acknowledgment is not on the definition's upsert, so no agent sets it.
 */
export function egressRefusalMessage(
  err: SsrfBlockedError | DnsBlockedError,
  serverName: string,
): string {
  const details = egressRefusalDetails(err);
  const host = details.target ?? 'the host';
  const where = `Integrations → ${serverName} → Private network`;
  const range = details.range !== undefined ? ` It is ${withArticle(details.range)}.` : '';
  let remedy = '';
  if (details.kind === 'unresolvable') {
    remedy =
      ` This machine cannot resolve ${host}.` +
      ' The VPN or its DNS may not reach the service from here.';
  } else if (details.kind === 'invalid-protocol') {
    remedy = ' Change the server URL to https. No setting lifts the https rule.';
  } else if (details.remedy === 'acknowledge_private_network') {
    remedy =
      `${range} An operator can let this server reach ${host} under ${where}.` +
      ' An agent cannot set it.';
  } else if (details.remedy === 'deployment_must_list_host') {
    remedy =
      `${range} Whoever runs this deployment adds ${host} to MCP_PRIVATE_NETWORK_HOSTS.` +
      ` The operator's setting is under ${where}.`;
  } else if (details.remedy === 'none') {
    remedy = `${range} No setting reaches it.`;
  }
  return `${err.message}${remedy}`.slice(0, MESSAGE_MAX_CHARS);
}

function withArticle(words: string): string {
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}
