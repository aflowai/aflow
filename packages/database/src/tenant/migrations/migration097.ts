/**
 * Tenant migration 97 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration097(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".artifact_bindings
        ADD COLUMN IF NOT EXISTS installed_content_hash text;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (97, 'Plan 158 §6 — artifact_bindings.installed_content_hash for divergence indicator')
      ON CONFLICT (version) DO NOTHING;
    `);
}
