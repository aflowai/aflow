import type postgres from 'postgres';

/**
 * A space keeps its autonomy posture and its Store update setting (Plan 345 D).
 * NULL reads as `ratify` and `follow-catalog`, so a space that never chose
 * keeps asking as before. The operator's two spaces, Full Circle and Trading
 * Joe, take `full` explicitly by name. A space that has stored a choice keeps it.
 */
export async function applyMigration239(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".spaces
      ADD COLUMN IF NOT EXISTS autonomy_policy jsonb;
    UPDATE "${schema}".spaces
      SET autonomy_policy = '{"autonomy":"full"}'::jsonb
      WHERE name IN ('Full Circle', 'Trading Joe') AND autonomy_policy IS NULL;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (239, 'Spaces keep an autonomy policy, and Full Circle and Trading Joe take full')
    ON CONFLICT (version) DO NOTHING;
  `);
}
