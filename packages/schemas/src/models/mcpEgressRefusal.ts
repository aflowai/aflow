/**
 * A refused MCP connect in words (Plan 336 D6). The MCP executor appends these
 * sentences to the step message the Helmsman reads, and the integration card
 * and form show them, so both say the same thing from one place.
 *
 * It lives here rather than in `@aflow/network-safety` because that package
 * imports Node's resolver, which the web bundle cannot load. It reads the kind
 * and the remedy, never the range label, so whether an address is reachable
 * stays `@aflow/network-safety`'s decision.
 */
import type { McpEgressRefusalDetails } from './mcpPrivateNetwork.js';

/** The card and form action that answers `acknowledge_private_network`. */
export const MCP_SET_PRIVATE_NETWORK_LABEL = 'Set as private network';

export interface McpEgressRefusalContext {
  /** The definition's name, as its card in Integrations shows it. */
  serverName: string;
  /**
   * Whether the definition has a private network acknowledgment set. The
   * Private network section exists only then, so without one the remedy names
   * the card's standing action that opens the form.
   */
  acknowledged: boolean;
}

function withArticle(words: string): string {
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}

/**
 * The refusal and what the operator can do about it, or `null` for a refusal
 * this does not describe. The tenant allowlist and an invalid URL say their
 * own reason in the message. The acknowledgment is not on the definition's
 * upsert, so no agent sets it.
 */
export function describeMcpEgressRefusal(
  refusal: McpEgressRefusalDetails,
  context: McpEgressRefusalContext,
): string | null {
  const host = refusal.target ?? 'The server';
  const range = refusal.range ?? refusal.rangeLabel;
  const onRange = `${host} is on ${range !== undefined ? withArticle(range) : 'a refused address'}.`;
  const section = `Integrations → ${context.serverName} → Private network`;
  switch (refusal.kind) {
    case 'unresolvable':
      return `This machine cannot resolve ${host}. The VPN or its DNS may not reach the service from here.`;
    case 'invalid-protocol':
      return `${host} is reached over https only. Change the server URL to https. No setting lifts the https rule.`;
    case 'private-ip':
      if (refusal.remedy === 'acknowledge_private_network') {
        const where = context.acknowledged
          ? `An operator can add ${host} to the hosts under ${section}.`
          : `An operator can let this server reach ${host} with the ${MCP_SET_PRIVATE_NETWORK_LABEL}` +
            ` action on the ${context.serverName} card in Integrations, which opens the private network form.`;
        return `${onRange} ${where} An agent cannot set it.`;
      }
      if (refusal.remedy === 'deployment_must_list_host') {
        return (
          `${onRange} It is set as a private network host, but this deployment does not list it.` +
          ` Whoever runs this deployment adds ${host} to MCP_PRIVATE_NETWORK_HOSTS.` +
          ` The operator's setting is under ${section}.`
        );
      }
      return `${onRange} No setting reaches it.`;
    case 'allowlist-host':
    case 'invalid-url':
      return null;
  }
}
