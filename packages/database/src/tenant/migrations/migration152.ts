import type postgres from 'postgres';

export async function applyMigration152(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".ui_artifact_drafts
        ADD COLUMN IF NOT EXISTS applet_definition jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (152, 'Applet definition emitted at generation persists on drafts until publish pins it')
      ON CONFLICT (version) DO NOTHING;
    `);
}
