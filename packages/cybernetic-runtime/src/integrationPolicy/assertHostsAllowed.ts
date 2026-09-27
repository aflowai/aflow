import { uncoveredHosts } from '@aflow/network-safety';
import { hostManifestHosts, type HostManifest } from '@aflow/schemas';
import {
  allowlistHostPatterns,
  type IntegrationAllowlistKind,
  type TenantIntegrationPolicy,
} from '@aflow/database';

export interface IntegrationPolicyDenial {
  code: 'INTEGRATION_HOST_NOT_ALLOWED';
  kind: IntegrationAllowlistKind;
  deniedHosts: string[];
  message: string;
}

export class IntegrationHostPolicyError extends Error {
  readonly code = 'INTEGRATION_HOST_NOT_ALLOWED' as const;
  readonly denial: IntegrationPolicyDenial;

  constructor(denial: IntegrationPolicyDenial) {
    super(denial.message);
    this.name = 'IntegrationHostPolicyError';
    this.denial = denial;
  }
}

export function integrationHostDenialMessage(deniedHosts: readonly string[]): string {
  const hostList = deniedHosts.map((host) => `"${host}"`).join(', ');
  const plural = deniedHosts.length > 1;
  return (
    `${plural ? 'Hosts' : 'Host'} ${hostList} ${plural ? 'are' : 'is'} not permitted by this ` +
    `tenant's integration policy (allowlist mode). Custom integrations may only reach hosts a ` +
    `tenant admin has allowed. Ask a tenant admin to allow ` +
    `${deniedHosts.join(', ')} under Tenant Admin → Integrations Policy, or use Request access ` +
    `on the space's Integrations page to file a request for admin review.`
  );
}

/**
 * The write-time / call-time host judgment: every declared host must be
 * covered by the tenant allowlist for its kind OR by the artifact's
 * captured-at-install catalog grant. Mode 'open' never reaches this — callers
 * short-circuit on the policy read.
 */
export function assertHostsAllowed(
  policy: TenantIntegrationPolicy,
  hosts: readonly string[],
  opts: { kind: IntegrationAllowlistKind; catalogGrant?: HostManifest | null | undefined },
): void {
  if (policy.mode === 'open' || hosts.length === 0) return;
  const permitted = [
    ...allowlistHostPatterns(policy, opts.kind),
    ...(opts.catalogGrant ? hostManifestHosts(opts.catalogGrant) : []),
  ];
  const denied = uncoveredHosts(hosts, permitted);
  if (denied.length === 0) return;
  throw new IntegrationHostPolicyError({
    code: 'INTEGRATION_HOST_NOT_ALLOWED',
    kind: opts.kind,
    deniedHosts: denied,
    message: integrationHostDenialMessage(denied),
  });
}
