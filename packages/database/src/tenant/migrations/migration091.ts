/**
 * Tenant migration 91 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration091(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".hitl_action_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        origin_kind TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        operation_id TEXT,
        kind TEXT NOT NULL,
        resolver_user_id UUID NOT NULL,
        resolution_kind TEXT NOT NULL,
        latency_ms INTEGER,
        gate_context JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
  
      CREATE INDEX IF NOT EXISTS idx_hitl_action_audit_space_created
        ON "${schemaName}".hitl_action_audit (space_id, created_at DESC);
  
      CREATE INDEX IF NOT EXISTS idx_hitl_action_audit_origin
        ON "${schemaName}".hitl_action_audit (origin_kind, origin_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (91, 'Plan 156 §5.5.5 — hitl_action_audit table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
