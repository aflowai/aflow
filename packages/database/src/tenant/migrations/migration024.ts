/**
 * Tenant migration 24 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration024(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 24: Add hot_state_snapshot to sessions for PAUSED session rehydration.
  // PAUSED sessions are no longer kept in the recovery manifest. Instead, the full
  // SessionHotState + StepHotState is snapshotted as JSONB on flush so the session can
  // be rehydrated on-demand from Postgres when Redis state has expired.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS hot_state_snapshot JSONB
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (24, 'Add hot_state_snapshot for PAUSED run rehydration')
      ON CONFLICT (version) DO NOTHING
    `);
}
