/**
 * Tenant repository - CRUD operations for tenant management.
 */
import { eq } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { type TenantId } from '@aflow/schemas';
import { tenants, type Tenant } from '../schema/public.js';
import {
  tenantIdToSchemaName,
  createTenantSchema,
  dropTenantSchema,
  tenantSchemaExists,
} from '../tenant.js';

// ============================================================================
// Tenant Status
// ============================================================================

export type TenantStatus = 'active' | 'disabled' | 'suspended' | 'deleted';

// ============================================================================
// Tenant Repository
// ============================================================================

export interface TenantRepository {
  /**
   * Create a new tenant with its schema.
   */
  create(params: {
    tenantId: TenantId;
    name: string;
    plan?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Tenant>;

  /**
   * Get a tenant by ID.
   */
  getById(tenantId: TenantId): Promise<Tenant | null>;

  /**
   * Get a tenant by schema name.
   */
  getBySchemaName(schemaName: string): Promise<Tenant | null>;

  /**
   * Update a tenant.
   */
  update(
    tenantId: TenantId,
    updates: Partial<Pick<Tenant, 'name' | 'status' | 'plan' | 'quotas' | 'metadata'>>,
  ): Promise<Tenant | null>;

  /**
   * Disable a tenant (soft delete).
   */
  disable(tenantId: TenantId): Promise<void>;

  /**
   * Delete a tenant and its schema.
   * WARNING: This is destructive.
   */
  delete(tenantId: TenantId): Promise<void>;

  /**
   * List all active tenants.
   */
  listActive(): Promise<Tenant[]>;

  /**
   * Check if a tenant exists.
   */
  exists(tenantId: TenantId): Promise<boolean>;
}

/**
 * Create a tenant repository instance.
 */
export function createTenantRepository(
  db: PostgresJsDatabase,
  sqlClient: postgres.Sql,
): TenantRepository {
  return {
    async create(params) {
      const schemaName = tenantIdToSchemaName(params.tenantId);

      // Create the tenant record
      const [tenant] = await db
        .insert(tenants)
        .values({
          tenantId: params.tenantId,
          schemaName,
          name: params.name,
          plan: params.plan ?? 'free',
          metadata: params.metadata ?? {},
          status: 'active',
        })
        .returning();

      if (!tenant) {
        throw new Error('Failed to create tenant record');
      }

      // Create the tenant schema with tables
      await createTenantSchema(sqlClient, params.tenantId);

      return tenant;
    },

    async getById(tenantId) {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.tenantId, tenantId))
        .limit(1);

      return tenant ?? null;
    },

    async getBySchemaName(schemaName) {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.schemaName, schemaName))
        .limit(1);

      return tenant ?? null;
    },

    async update(tenantId, updates) {
      const [tenant] = await db
        .update(tenants)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(tenants.tenantId, tenantId))
        .returning();

      return tenant ?? null;
    },

    async disable(tenantId) {
      await db
        .update(tenants)
        .set({
          status: 'disabled',
          updatedAt: new Date(),
        })
        .where(eq(tenants.tenantId, tenantId));
    },

    async delete(tenantId) {
      // First check if schema exists and drop it
      const exists = await tenantSchemaExists(sqlClient, tenantId);
      if (exists) {
        await dropTenantSchema(sqlClient, tenantId);
      }

      // Delete the tenant record
      await db.delete(tenants).where(eq(tenants.tenantId, tenantId));
    },

    async listActive() {
      return db.select().from(tenants).where(eq(tenants.status, 'active'));
    },

    async exists(tenantId) {
      const [result] = await db
        .select({ count: tenants.tenantId })
        .from(tenants)
        .where(eq(tenants.tenantId, tenantId))
        .limit(1);

      return result !== undefined;
    },
  };
}
