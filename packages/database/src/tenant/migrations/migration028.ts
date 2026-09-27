/**
 * Tenant migration 28 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration028(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Stores space-level compute policy for sandboxed code execution:
  // enabled flag, network egress mode, resource limits, concurrency.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS compute_policy JSONB
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (28, 'Plan 79 — Add compute_policy column to spaces for sandboxed code execution')
      ON CONFLICT (version) DO NOTHING
    `);

  // ---------------------------------------------------------------------------
}
