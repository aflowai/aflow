import type postgres from 'postgres';

/**
 * A space keeps its autonomy posture and its Store update setting (Plan 345 D).
 * NULL is every default, read at each use, so existing spaces take `full` and
 * `follow-catalog` without a row being written.
 */
export async function applyMigration239(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".spaces
      ADD COLUMN IF NOT EXISTS autonomy_policy jsonb;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (239, 'Spaces keep an autonomy policy')
    ON CONFLICT (version) DO NOTHING;
  `);
}
