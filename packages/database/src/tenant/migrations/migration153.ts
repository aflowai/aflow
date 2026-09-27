import type postgres from 'postgres';

export async function applyMigration153(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ADD COLUMN IF NOT EXISTS assets_manifest jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (153, 'Published applet versions pin captured library assets so their HTML renders with no external fetch')
      ON CONFLICT (version) DO NOTHING;
    `);
}
