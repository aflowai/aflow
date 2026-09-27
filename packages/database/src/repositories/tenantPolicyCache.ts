/**
 * Shared read-through cache for the tenant integration policy plus the
 * catalog-grant hydration both executors fold onto. On a policy read error the
 * last-known-good policy is kept — a flaky DB must not silently waive an
 * allowlist; 'open' is only the default when nothing was ever loaded.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { hostManifestHosts } from '@aflow/schemas';
import { listCatalogHostGrants } from '../tenant/storeHostGrants.js';
import {
  getTenantIntegrationPolicy,
  OPEN_INTEGRATION_POLICY,
  type TenantIntegrationPolicy,
} from './integrationPolicy.js';

export interface TenantPolicyCache {
  load(db: unknown, tenantId: string, opts?: { ttlMs?: number }): Promise<TenantIntegrationPolicy>;
  /** Last loaded policy without touching the database (undefined until a load ran). */
  peek(tenantId: string): TenantIntegrationPolicy | undefined;
}

export function createTenantPolicyCache(options?: {
  ttlMs?: number;
  onLoadError?: (tenantId: string, error: unknown) => void;
}): TenantPolicyCache {
  const defaultTtlMs = options?.ttlMs ?? 2_000;
  const policies = new Map<string, TenantIntegrationPolicy>();
  const loadedAtMs = new Map<string, number>();

  return {
    async load(db, tenantId, opts) {
      const ttlMs = opts?.ttlMs ?? defaultTtlMs;
      const cached = policies.get(tenantId);
      const loadedAt = loadedAtMs.get(tenantId);
      if (cached !== undefined && loadedAt !== undefined && Date.now() - loadedAt < ttlMs) {
        return cached;
      }

      let policy = cached ?? OPEN_INTEGRATION_POLICY;
      if (db) {
        try {
          policy = await getTenantIntegrationPolicy(db as PostgresJsDatabase, tenantId);
        } catch (err) {
          options?.onLoadError?.(tenantId, err);
        }
      }
      policies.set(tenantId, policy);
      loadedAtMs.set(tenantId, Date.now());
      return policy;
    },

    peek(tenantId) {
      return policies.get(tenantId);
    },
  };
}

export function catalogGrantKey(artifactType: string, artifactKey: string): string {
  return `${artifactType}:${artifactKey}`;
}

/**
 * `${artifactType}:${artifactKey}` → flattened captured-grant hosts for one
 * space. Run inside a `withTenantSchema` transaction. Missing provenance
 * tables yield an empty map — allowlist rows still apply.
 */
export async function buildCatalogGrantMap(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<Map<string, string[]>> {
  const grantMap = new Map<string, string[]>();
  let grants;
  try {
    grants = await listCatalogHostGrants(tx, spaceId);
  } catch {
    return grantMap;
  }
  for (const grant of grants) {
    grantMap.set(
      catalogGrantKey(grant.artifactType, grant.artifactKey),
      hostManifestHosts(grant.hostManifest),
    );
  }
  return grantMap;
}
