/**
 * Tenant migration module contract.
 */
import type postgres from 'postgres';

export type TenantMigrationFn = (sqlClient: postgres.Sql, schemaName: string) => Promise<void>;
