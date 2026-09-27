/**
 * Canonical `provider_credentials` loader — the one DB implementation of
 * {@link CredentialLoader} so every consumer resolves from the same rows.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema, providerCredentials } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import type { CredentialLoader } from './types.js';

export function createProviderCredentialDbLoader(db: PostgresJsDatabase): CredentialLoader {
  return async (tenantId, providerId) => {
    const tenantContext = createTenantContext(tenantId as TenantId);
    try {
      const rows = await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(providerCredentials)
          .where(sql`${providerCredentials.providerId} = ${providerId}`);
      });
      return (rows as Array<typeof providerCredentials.$inferSelect>).map((r) => ({
        id: r.id,
        providerId: r.providerId,
        scope: r.scope,
        scopeId: r.scopeId,
        encryptedSecrets: r.encryptedSecrets,
        configJson: (r.configJson ?? {}) as Record<string, unknown>,
        status: r.status ?? 'active',
        updatedAt: r.updatedAt.toISOString(),
      }));
    } catch {
      // Table may not exist yet (migration not applied) — resolve nothing.
      return [];
    }
  };
}
