import type postgres from 'postgres';
export async function applyMigration232(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".plan_node_links
      ADD COLUMN IF NOT EXISTS trusted_for_close BOOLEAN NOT NULL DEFAULT false;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (232, 'Plan 331 — trusted pull request provenance')
    ON CONFLICT (version) DO NOTHING;
  `);
}
