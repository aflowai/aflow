import type postgres from 'postgres';

export async function applyMigration154(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".applet_instances
        ADD COLUMN IF NOT EXISTS upgraded_from_version_id uuid,
        ADD COLUMN IF NOT EXISTS upgraded_at timestamptz;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (154, 'Applet instance upgrade provenance: the version an instance was last repinned from')
      ON CONFLICT (version) DO NOTHING;
    `);
}
