import type postgres from 'postgres';

/**
 * A space keeps its autonomy posture and its Store update setting (Plan 345 D).
 * NULL reads as `ratify` and `follow-catalog`, so a space that never chose
 * keeps asking as before. The migration writes no posture for any space,
 * because every local-edition install shares one tenant id. A space takes
 * `full` through `PUT /v1/spaces/:spaceId/autonomy` alone.
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
