import type { IntegrationCredentialMeta, McpServerBindingSummary } from './use-mcp-integrations.js';

export type McpReadiness =
  'connected' | 'needs_secret' | 'not_connected' | 'paused' | 'no_connection';

/**
 * Whether the agent can actually reach this MCP server right now. Recomputed
 * from live connection + credential state rather than read off a stored flag:
 * the secret a connection resolves through can be deleted, and the pinned origin
 * is only established once a handshake has succeeded.
 */
export function getMcpReadiness(
  binding: McpServerBindingSummary | undefined,
  credentialsByKey: Map<string, IntegrationCredentialMeta>,
): McpReadiness {
  if (!binding) return 'no_connection';
  const credentialed = binding.authType !== 'none';

  if (credentialed) {
    const missingSecret =
      binding.credentialKeys.length === 0 ||
      binding.credentialKeys.some((k) => !credentialsByKey.get(k)?.hasValue);
    if (missingSecret) return 'needs_secret';
    if (!binding.pinnedOrigin) return 'not_connected';
  }
  if (!binding.enabled) return 'paused';
  return 'connected';
}
