import type postgres from 'postgres';

/**
 * Plan 331 D5 — `plan_nodes.opened_at`: when a person last opened the node,
 * written by the open write in its own statement. A node's spend counts from
 * it, so lifting a spend stop resets the spend synchronously rather than
 * waiting on the buffered audit log.
 */
export async function applyMigration230(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".plan_nodes
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (230, 'Plan 331 — when a person last opened a plan node')
    ON CONFLICT (version) DO NOTHING;
  `);
}
