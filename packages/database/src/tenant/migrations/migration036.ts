/**
 * Tenant migration 36 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration036(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ALTER COLUMN compiled_ref DROP NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (36, 'Plan 96 — Allow nullable compiled_ref for non-compiled artifact kinds (applet, illustration)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
