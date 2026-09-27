/**
 * Tenant schema naming and context helpers.
 */
import { type TenantId } from '@aflow/schemas';

// ============================================================================
// Tenant Schema Naming
// ============================================================================

/**
 * Convert a tenant UUID to a safe schema name.
 * Uses a deterministic mapping to avoid SQL injection.
 *
 * Format: tenant_<base32_encoded_uuid>
 */
export function tenantIdToSchemaName(tenantId: TenantId): string {
  // Remove dashes and encode as lowercase alphanumeric
  const cleanId = tenantId.replace(/-/g, '').toLowerCase();

  // Validate it's a valid hex string (from UUID)
  if (!/^[0-9a-f]{32}$/.test(cleanId)) {
    throw new Error(`Invalid tenant ID format: ${tenantId}`);
  }

  // Use a short prefix + the clean ID
  return `t_${cleanId}`;
}

/**
 * Extract tenant ID from a schema name.
 */
export function schemaNameToTenantId(schemaName: string): TenantId {
  if (!schemaName.startsWith('t_')) {
    throw new Error(`Invalid tenant schema name format: ${schemaName}`);
  }

  const cleanId = schemaName.slice(2);
  if (!/^[0-9a-f]{32}$/.test(cleanId)) {
    throw new Error(`Invalid tenant schema name format: ${schemaName}`);
  }

  // Reconstruct UUID format
  const uuid = [
    cleanId.slice(0, 8),
    cleanId.slice(8, 12),
    cleanId.slice(12, 16),
    cleanId.slice(16, 20),
    cleanId.slice(20, 32),
  ].join('-');

  return uuid as TenantId;
}

/**
 * Validate that a schema name is safe for use in SQL.
 */
export function isValidSchemaName(schemaName: string): boolean {
  return /^t_[0-9a-f]{32}$/.test(schemaName);
}

// ============================================================================
// Tenant Context
// ============================================================================

/**
 * Tenant context for database operations.
 */
export interface TenantContext {
  tenantId: TenantId;
  schemaName: string;
}

/**
 * Create a tenant context from a tenant ID.
 */
export function createTenantContext(tenantId: TenantId): TenantContext {
  return {
    tenantId,
    schemaName: tenantIdToSchemaName(tenantId),
  };
}
