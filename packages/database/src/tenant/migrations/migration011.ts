/**
 * Tenant migration 11 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration011(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".tenant_audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id    UUID,
        actor_kind  TEXT NOT NULL,
        category    TEXT NOT NULL,
        action      TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        space_id    UUID,
        details     JSONB,
        ip_address  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_timestamp
        ON "${schemaName}".tenant_audit_log (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_actor
        ON "${schemaName}".tenant_audit_log (actor_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_tenant_audit_log_resource
        ON "${schemaName}".tenant_audit_log (resource_type, resource_id);
  
      -- Add actor_context column to sessions for durable attribution
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS actor_context JSONB;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (11, 'Plans 27+30 — tenant audit log + actor_context on flow_runs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
