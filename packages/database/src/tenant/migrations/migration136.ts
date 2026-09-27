import type postgres from 'postgres';

export async function applyMigration136(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".store_installs
        ADD COLUMN IF NOT EXISTS host_manifest_json jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (136, 'Plan 244 P3 — captured-at-install host manifest on store_installs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
