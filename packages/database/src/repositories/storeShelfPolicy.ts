/**
 * Tenant store shelf policy read — the one authority the store read and
 * install paths consult for per-tenant listing availability.
 */
import { eq } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { StoreListingAvailability } from '@aflow/schemas';
import { tenants, tenantStoreOverrides } from '../schema/public.js';

export interface TenantStoreShelfPolicy {
  defaultAvailability: StoreListingAvailability;
  overrides: ReadonlyMap<string, StoreListingAvailability>;
}

const NO_OVERRIDES: ReadonlyMap<string, StoreListingAvailability> = new Map();

export const OPEN_SHELF_POLICY: TenantStoreShelfPolicy = Object.freeze({
  defaultAvailability: 'available' as const,
  overrides: NO_OVERRIDES,
});

function asAvailability(value: string): StoreListingAvailability {
  return value === 'hidden' ? 'hidden' : 'available';
}

export async function getTenantStoreShelfPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<TenantStoreShelfPolicy> {
  const rows = await db
    .select({ defaultAvailability: tenants.storeDefaultAvailability })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  const defaultAvailability = asAvailability(rows[0]?.defaultAvailability ?? 'available');

  const overrideRows = await db
    .select({
      catalogId: tenantStoreOverrides.catalogId,
      availability: tenantStoreOverrides.availability,
    })
    .from(tenantStoreOverrides)
    .where(eq(tenantStoreOverrides.tenantId, tenantId));
  if (overrideRows.length === 0 && defaultAvailability === 'available') return OPEN_SHELF_POLICY;

  return {
    defaultAvailability,
    overrides: new Map(
      overrideRows.map((row) => [row.catalogId, asAvailability(row.availability)]),
    ),
  };
}
