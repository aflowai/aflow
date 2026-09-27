/**
 * Tenant migration 26 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration026(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".webhook_endpoints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        secret_encrypted TEXT NOT NULL,
        signature_header TEXT NOT NULL DEFAULT 'x-webhook-signature',
        delivery_id_header TEXT NOT NULL DEFAULT 'x-webhook-id',
        timestamp_header TEXT NOT NULL DEFAULT 'x-webhook-timestamp',
        replay_window_seconds INTEGER NOT NULL DEFAULT 300,
        require_delivery_id BOOLEAN NOT NULL DEFAULT false,
        input_mapping JSONB,
        filter_expression TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        creator_user_id UUID,
        creator_tenant_role TEXT,
        creator_space_role TEXT,
        last_received_at TIMESTAMPTZ,
        last_error TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_space_id
        ON "${schemaName}".webhook_endpoints (space_id)
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_status
        ON "${schemaName}".webhook_endpoints (status) WHERE status = 'active'
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (26, 'Plan 78 — Webhook endpoints for reactive triggers')
      ON CONFLICT (version) DO NOTHING
    `);

  // ---------------------------------------------------------------------------
}
