/**
 * Tenant migration 23 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration023(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".provider_credentials (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id       TEXT NOT NULL,
        scope             TEXT NOT NULL,
        scope_id          UUID NOT NULL,
        encrypted_secrets TEXT NOT NULL,
        config_json       JSONB NOT NULL DEFAULT '{}',
        label             TEXT,
        created_by        UUID NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        last_validated_at TIMESTAMPTZ,
        last_error_at     TIMESTAMPTZ,
        last_error_code   TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  await sqlClient.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_credentials_scope
        ON "${schemaName}".provider_credentials (provider_id, scope, scope_id)
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_provider_credentials_lookup
        ON "${schemaName}".provider_credentials (provider_id, scope, scope_id)
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_provider_credentials_scope_id
        ON "${schemaName}".provider_credentials (scope_id)
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (23, 'Plan 67 — Provider credentials (BYOK)')
      ON CONFLICT (version) DO NOTHING
    `);
}
