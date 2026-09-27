/**
 * Tenant migration 29 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration029(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 29 — Drop sessions FK on (agent_id, agent_version)
  // ---------------------------------------------------------------------------

  // Inline agents (created via API with `inline-<uuid>` IDs) are never persisted
  // to agent_definitions. The FK constraint causes ProjectionWorker failures when
  // flushing inline agent sessions to Postgres. agent_id is informational — the agent
  // config lives in Redis hot state and the session itself is the source of truth.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        DROP CONSTRAINT IF EXISTS flow_runs_flow_id_flow_version_fkey
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (29, 'Drop flow_runs FK on (flow_id, flow_version) — inline flows are not in flow_definitions')
      ON CONFLICT (version) DO NOTHING
    `);
}
