import type postgres from 'postgres';

export async function applyMigration119(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".api_definitions
        ALTER COLUMN base_url DROP NOT NULL;

      ALTER TABLE "${schemaName}".api_bindings
        ADD COLUMN IF NOT EXISTS variable_values_json jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (119, 'Plan 218 — api_definitions.base_url nullable + api_bindings.variable_values_json (baseUrlTemplate variables)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
