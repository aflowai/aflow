/**
 * Tenant provisioning policy read — the one authority JIT user provisioning
 * and space creation consult for signup admission and per-user quotas.
 * A missing tenant row yields the invite-only default with no quotas.
 */
import { eq } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { parseTenantQuotas, type TenantQuotas, type TenantSignupPolicy } from '@aflow/schemas';
import { tenants } from '../schema/public.js';

export interface TenantProvisioningPolicy {
  signupPolicy: TenantSignupPolicy;
  quotas: TenantQuotas;
}

export async function getTenantProvisioningPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<TenantProvisioningPolicy> {
  const rows = await db
    .select({ signupPolicy: tenants.signupPolicy, quotas: tenants.quotas })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  const row = rows[0];
  return {
    signupPolicy: row?.signupPolicy === 'open' ? 'open' : 'invite_only',
    quotas: parseTenantQuotas(row?.quotas),
  };
}

export async function getTenantSignupPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<TenantSignupPolicy> {
  return (await getTenantProvisioningPolicy(db, tenantId)).signupPolicy;
}

export interface EmbeddingBudgetLimitsView {
  perSpaceTokens?: number;
  tenantTokens?: number;
}

/**
 * Cached per-tenant view of the embedding budget knobs — the embed workers
 * consult this on every job, so reads are coalesced behind a short TTL
 * rather than hitting `tenants` per chunk.
 */
export function createEmbeddingBudgetLimitsLoader(
  db: PostgresJsDatabase,
  cacheTtlMs = 60_000,
): (tenantId: string) => Promise<EmbeddingBudgetLimitsView> {
  const cache = new Map<string, { value: EmbeddingBudgetLimitsView; expiresAt: number }>();
  return async (tenantId: string) => {
    const hit = cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const { quotas } = await getTenantProvisioningPolicy(db, tenantId);
    const value: EmbeddingBudgetLimitsView = {
      ...(quotas.embeddingDailyTokensPerSpace !== undefined
        ? { perSpaceTokens: quotas.embeddingDailyTokensPerSpace }
        : {}),
      ...(quotas.embeddingDailyTokensTenant !== undefined
        ? { tenantTokens: quotas.embeddingDailyTokensTenant }
        : {}),
    };
    cache.set(tenantId, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  };
}

export interface ComputeBudgetLimitsView {
  perSpaceSeconds?: number;
  tenantSeconds?: number;
}

/**
 * Cached per-tenant view of the compute budget knobs — the compute executor
 * consults this before every sandbox call, so reads are coalesced behind a
 * short TTL rather than hitting `tenants` per exec.
 */
export function createComputeBudgetLimitsLoader(
  db: PostgresJsDatabase,
  cacheTtlMs = 60_000,
): (tenantId: string) => Promise<ComputeBudgetLimitsView> {
  const cache = new Map<string, { value: ComputeBudgetLimitsView; expiresAt: number }>();
  return async (tenantId: string) => {
    const hit = cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const { quotas } = await getTenantProvisioningPolicy(db, tenantId);
    const value: ComputeBudgetLimitsView = {
      ...(quotas.computeDailySecondsPerSpace !== undefined
        ? { perSpaceSeconds: quotas.computeDailySecondsPerSpace }
        : {}),
      ...(quotas.computeDailySecondsTenant !== undefined
        ? { tenantSeconds: quotas.computeDailySecondsTenant }
        : {}),
    };
    cache.set(tenantId, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  };
}
