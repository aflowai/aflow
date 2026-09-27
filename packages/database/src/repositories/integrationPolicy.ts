/**
 * Tenant integration policy read — the one authority both the write-time
 * enforcement (server routes, orchestrator inline ops, ratification) and the
 * executors' call-time backstop consult.
 */
import { eq } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { IntegrationAllowlistKind, IntegrationPolicyMode } from '@aflow/schemas';
import { tenants, tenantIntegrationAllowlist } from '../schema/public.js';

export type { IntegrationAllowlistKind, IntegrationPolicyMode };

export interface TenantIntegrationPolicy {
  mode: IntegrationPolicyMode;
  /** Empty when mode is 'open' — never consulted in that mode. */
  allowlist: Array<{ kind: IntegrationAllowlistKind; hostPattern: string }>;
}

export const OPEN_INTEGRATION_POLICY: TenantIntegrationPolicy = Object.freeze({
  mode: 'open',
  allowlist: [],
});

export function allowlistHostPatterns(
  policy: TenantIntegrationPolicy,
  kind: IntegrationAllowlistKind,
): string[] {
  return policy.allowlist.filter((row) => row.kind === kind).map((row) => row.hostPattern);
}

export async function getTenantIntegrationPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<TenantIntegrationPolicy> {
  const rows = await db
    .select({ mode: tenants.integrationPolicyMode })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  if (rows[0]?.mode !== 'allowlist') return OPEN_INTEGRATION_POLICY;

  const allowRows = await db
    .select({
      kind: tenantIntegrationAllowlist.kind,
      hostPattern: tenantIntegrationAllowlist.hostPattern,
    })
    .from(tenantIntegrationAllowlist)
    .where(eq(tenantIntegrationAllowlist.tenantId, tenantId));
  return {
    mode: 'allowlist',
    allowlist: allowRows.map((row) => ({
      kind: row.kind === 'mcp' ? 'mcp' : 'api',
      hostPattern: row.hostPattern,
    })),
  };
}
