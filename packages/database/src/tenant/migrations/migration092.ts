/**
 * Tenant migration 92 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration092(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".action_center_items_projection (
        space_id UUID NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin JSONB NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body_ref TEXT,
        ui_hints JSONB,
        resolution_schema JSONB,
        requested_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        requested_by JSONB NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        gate_context JSONB,
        relates_to JSONB NOT NULL DEFAULT '[]'::jsonb,
        resolver_policy JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at TIMESTAMPTZ,
        resolved_by UUID,
        resolution JSONB,
        resolution_error JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (space_id, item_id)
      );
  
      CREATE INDEX IF NOT EXISTS idx_action_center_items_open
        ON "${schemaName}".action_center_items_projection (space_id, requested_at DESC)
        WHERE status = 'open';
  
      CREATE INDEX IF NOT EXISTS idx_action_center_items_kind_open
        ON "${schemaName}".action_center_items_projection (space_id, kind)
        WHERE status = 'open';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (92, 'Plan 156 §5.1.1 — action_center_items_projection table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
