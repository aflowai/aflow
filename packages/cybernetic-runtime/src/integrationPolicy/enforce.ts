import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';
import { mergeHostManifests, type HostManifest } from '@aflow/schemas';
import {
  createTenantContext,
  getCatalogHostGrants,
  getTenantIntegrationPolicy,
  withTenantSchema,
  type CatalogGrantArtifactRef,
  type IntegrationAllowlistKind,
} from '@aflow/database';
import { getCyberneticLogger } from '../logger.js';
import { assertHostsAllowed, IntegrationHostPolicyError } from './assertHostsAllowed.js';

/**
 * The shared write-time gate every integration write funnels through when the
 * tenant runs in allowlist mode. `catalogGrant` short-circuits the lookup for
 * a store install applying its own listing; `grantRefs` resolves the
 * captured-at-install grant for edits of catalog-installed artifacts, so only
 * hosts BEYOND the vetted surface are judged against the allowlist.
 */
export async function enforceIntegrationHostPolicy(opts: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  kind: IntegrationAllowlistKind;
  hosts: readonly string[];
  grantRefs?: readonly CatalogGrantArtifactRef[] | undefined;
  catalogGrant?: HostManifest | null | undefined;
}): Promise<void> {
  if (opts.hosts.length === 0) return;
  const policy = await getTenantIntegrationPolicy(opts.db, opts.tenantId);
  if (policy.mode === 'open') return;

  let catalogGrant = opts.catalogGrant ?? null;
  if (catalogGrant === null && opts.grantRefs !== undefined && opts.grantRefs.length > 0) {
    const refs = opts.grantRefs;
    const grants = await withTenantSchema(
      opts.db,
      createTenantContext(opts.tenantId as TenantId),
      async (tx) => getCatalogHostGrants(tx, opts.spaceId, refs),
    );
    if (grants.length > 0) {
      catalogGrant = mergeHostManifests(grants.map((grant) => grant.hostManifest));
    }
  }

  try {
    assertHostsAllowed(policy, opts.hosts, { kind: opts.kind, catalogGrant });
  } catch (err) {
    if (err instanceof IntegrationHostPolicyError) {
      getCyberneticLogger().warn('Integration host policy denial', {
        tenantId: opts.tenantId,
        spaceId: opts.spaceId,
        kind: opts.kind,
        deniedHosts: err.denial.deniedHosts,
        requestedHosts: [...opts.hosts],
      });
    }
    throw err;
  }
}
