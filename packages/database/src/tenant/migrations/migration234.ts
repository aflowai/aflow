import type postgres from 'postgres';

/** Plan 337 D1: the decision card a plan node carries, read and written whole. */
export async function applyMigration234(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".plan_nodes
      ADD COLUMN IF NOT EXISTS card JSONB;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (234, 'Plan 337 — the decision card on a plan node')
    ON CONFLICT (version) DO NOTHING;
  `);
}
