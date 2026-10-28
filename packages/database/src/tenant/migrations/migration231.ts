import type postgres from 'postgres';

export async function applyMigration231(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".plan_nodes
      ADD COLUMN IF NOT EXISTS spend_cents INTEGER CHECK (spend_cents > 0 AND spend_cents <= 1000000);
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (231, 'Plan 331 — operator-owned node spend ceiling')
    ON CONFLICT (version) DO NOTHING;
  `);
}
