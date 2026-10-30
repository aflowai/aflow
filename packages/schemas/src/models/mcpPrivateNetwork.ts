/**
 * The private network acknowledgment (Plan 336 D2): the hosts of one MCP
 * server definition that the operator lets resolve to a private address.
 *
 * Kept out of `McpServerDefinitionSchema` on purpose. That schema is what
 * `mcp.server.upsert` and a skill bundle carry, so a field on it would be
 * writable by an agent and travel in a bundle. The record has its own column
 * and its own operator-only route.
 */
import { z } from 'zod';
import { isBlockedNetworkHost } from './repoBinding.js';

/** Where whoever runs a hosted deployment lists the hosts it lets an acknowledgment reach. */
export const MCP_PRIVATE_NETWORK_HOSTS_ENV = 'MCP_PRIVATE_NETWORK_HOSTS';

export const MCP_PRIVATE_NETWORK_MAX_HOSTS = 32;

export const MCP_PRIVATE_NETWORK_AUDIT_ACTIONS = {
  set: 'mcp.private_network.set',
  cleared: 'mcp.private_network.cleared',
} as const;

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*$/;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const CANONICAL_QUAD = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|\d+)$/;

/** Lowercased and trimmed, without the trailing dot that names the same host. */
export function normalizePrivateNetworkHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.endsWith('.') ? lowered.slice(0, -1) : lowered;
}

/**
 * Why a host cannot be listed, or `null` when it can. An entry is one exact
 * hostname or one canonical dotted quad. The address it resolves to is judged
 * at every connect, so this refuses only what no answer could make reachable.
 */
export function privateNetworkHostProblem(host: string): string | null {
  const lowered = normalizePrivateNetworkHost(host);
  if (lowered === '') return 'is empty';
  if (lowered.length > 253) return 'is longer than a hostname can be';
  if (lowered.includes('*')) return 'is a wildcard. Name each host exactly';
  if (/[/@?#\s]/.test(lowered) || /^[^:]+:\d*$/.test(lowered)) {
    return 'is not a bare host. Leave out the scheme, port and path';
  }
  if (isBlockedNetworkHost(lowered)) {
    return 'is a loopback, link-local, metadata or IPv6 address, which no setting reaches';
  }
  if (!HOSTNAME.test(lowered)) return 'is not a hostname or a dotted quad';
  if (lowered.split('.').every((label) => NUMERIC_LABEL.test(label))) {
    if (!CANONICAL_QUAD.test(lowered)) return 'is a numeric address. Write it as a dotted quad';
  }
  return null;
}

export const McpPrivateNetworkAcknowledgmentSchema = z.object({
  /** Exact hosts, normalized. The `serverUrl` host and any token or authorization endpoint host. */
  hosts: z.array(z.string().min(1).max(253)).min(1).max(MCP_PRIVATE_NETWORK_MAX_HOSTS),
  /** The user who set it, stamped by the server. */
  setBy: z.string().min(1),
  setAt: z.string().datetime(),
});
export type McpPrivateNetworkAcknowledgment = z.infer<typeof McpPrivateNetworkAcknowledgmentSchema>;

/** A stored record, or `null` for none or one that does not parse. */
export function parseMcpPrivateNetworkAcknowledgment(
  raw: unknown,
): McpPrivateNetworkAcknowledgment | null {
  if (raw === null || raw === undefined) return null;
  const parsed = McpPrivateNetworkAcknowledgmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const McpPrivateNetworkSetInputSchema = z.object({
  hosts: z
    .array(z.string().max(253))
    .max(MCP_PRIVATE_NETWORK_MAX_HOSTS)
    .describe(
      'Every host this server definition may reach on a private address: the server URL host, ' +
        'and any token or authorization endpoint host. It replaces the stored list whole. ' +
        'An empty list clears the acknowledgment.',
    ),
});
export type McpPrivateNetworkSetInput = z.infer<typeof McpPrivateNetworkSetInputSchema>;

export const McpPrivateNetworkSetResultSchema = z.object({
  serverId: z.string(),
  action: z.enum(['set', 'cleared', 'unchanged']),
  privateNetwork: McpPrivateNetworkAcknowledgmentSchema.nullable(),
});
export type McpPrivateNetworkSetResult = z.infer<typeof McpPrivateNetworkSetResultSchema>;

/**
 * The hosts the deployment lists in `MCP_PRIVATE_NETWORK_HOSTS`. Read only by
 * the hosted edition. The local edition's operator is the deployment.
 */
export function mcpPrivateNetworkDeploymentHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      (env[MCP_PRIVATE_NETWORK_HOSTS_ENV] ?? '')
        .split(',')
        .map(normalizePrivateNetworkHost)
        .filter((host) => host !== ''),
    ),
  ];
}
