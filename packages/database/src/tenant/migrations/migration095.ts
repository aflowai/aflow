/**
 * Tenant migration 95 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration095(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ALTER COLUMN compiled_ref DROP NOT NULL;
  
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ALTER COLUMN html_ref DROP NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (95, 'Plan 158 §4.2 — ui_artifact_versions.compiled_ref + html_ref nullable for lazy compile')
      ON CONFLICT (version) DO NOTHING;
    `);
}
