import { allowlistHostPatterns, catalogGrantKey } from '@aflow/database';
import { isHostAllowed, SsrfBlockedError } from '@aflow/network-safety';
import { getMcpSpaceStores, type McpHandlerStores } from './types.js';

export interface McpTenantGuardRef {
  tenantId: string;
  spaceId: string;
  serverId: string;
  bindingId: string;
}

/**
 * Allowlist-mode permitted hosts for one binding — tenant allowlist plus the
 * artifact's captured catalog grant, from the loader's caches. Null when the
 * tenant is not in allowlist mode (or no guard applies).
 */
export function tenantPolicyPermittedHosts(
  stores: McpHandlerStores,
  guard: McpTenantGuardRef | null,
): string[] | null {
  if (guard === null) return null;
  const policy = stores.tenantPolicyCache.peek(guard.tenantId);
  if (policy?.mode !== 'allowlist') return null;
  const slice = getMcpSpaceStores(stores, guard.tenantId, guard.spaceId);
  return [
    ...allowlistHostPatterns(policy, 'mcp'),
    ...(slice.catalogGrantStore.get(catalogGrantKey('mcp_definition', guard.serverId)) ?? []),
    ...(slice.catalogGrantStore.get(catalogGrantKey('mcp_binding', guard.bindingId)) ?? []),
  ];
}

function hostCovered(host: string, permitted: readonly string[]): boolean {
  return isHostAllowed(
    host.toLowerCase(),
    permitted.map((p) => p.toLowerCase()),
  );
}

/**
 * Allowlist-mode backstop, recomputed at connect time: the server host must
 * be covered by the tenant allowlist or the server's captured catalog grant —
 * a definition written before a policy tightening fails closed here. Raised
 * as an SSRF block so every connect caller's existing error handling converts
 * it to a non-retryable validation failure.
 */
export function assertTenantPolicyPermitsConnect(
  stores: McpHandlerStores,
  serverUrl: string,
  guard: McpTenantGuardRef | null,
): void {
  const permitted = tenantPolicyPermittedHosts(stores, guard);
  if (permitted === null) return;
  let host: string;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${serverUrl}`, serverUrl, { kind: 'invalid-url' });
  }
  if (hostCovered(host, permitted)) return;
  throw new SsrfBlockedError(
    `Connection blocked by the tenant integration policy: MCP server host "${host}" is not ` +
      `covered by the tenant allowlist or this server's catalog grant. Ask a tenant admin to ` +
      `allow ${host} under Tenant Admin → Integrations Policy, or use Request access on the ` +
      `space's Integrations page.`,
    serverUrl,
    { kind: 'allowlist-host' },
  );
}

/**
 * Same backstop for the client-credentials token exchange: the exchange POSTs
 * the client secret to a space-authored endpoint, so its host is judged by
 * the same permitted set before any secret leaves the platform.
 */
export function assertTenantPolicyPermitsTokenEndpoint(
  permittedHosts: readonly string[] | null | undefined,
  tokenEndpoint: string,
): void {
  if (permittedHosts === null || permittedHosts === undefined) return;
  let host: string | null;
  try {
    host = new URL(tokenEndpoint).hostname;
  } catch {
    // validateCredentialedUrl rejects the malformed endpoint on the exchange path.
    return;
  }
  if (hostCovered(host, permittedHosts)) return;
  throw new SsrfBlockedError(
    `Token exchange blocked by the tenant integration policy: OAuth token endpoint host ` +
      `"${host}" is not covered by the tenant allowlist or this server's catalog grant. Ask a ` +
      `tenant admin to allow ${host} under Tenant Admin → Integrations Policy, or use Request ` +
      `access on the space's Integrations page.`,
    tokenEndpoint,
    { kind: 'allowlist-host' },
  );
}
