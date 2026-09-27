/**
 * Tenant migration 8 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration008(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 8: API Credentials (encrypted secret storage)
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".api_credentials (
        credential_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        encrypted_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (8, 'API Executor v2 — encrypted credentials table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
