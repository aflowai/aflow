import type postgres from 'postgres';

/**
 * A renewal records the schedule its chain began with.
 *
 * A renewing schedule writes a successor every few dozen firings, so a chain
 * grows without end. `original_schedule_id` names the first schedule of the
 * chain on every renewal and stays NULL on the first schedule itself. A reader
 * that wants a chain's newest renewal reads it through the index instead of
 * walking every renewal from the start. The backfill walks each existing chain
 * once.
 */
export async function applyMigration235(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".agent_schedules
        ADD COLUMN IF NOT EXISTS original_schedule_id UUID;

      WITH RECURSIVE walk AS (
        SELECT original.id AS original_id, original.id
        FROM "${schemaName}".agent_schedules original
        WHERE original.renews_schedule_id IS NULL
          AND EXISTS (
            SELECT 1 FROM "${schemaName}".agent_schedules renewal
            WHERE renewal.renews_schedule_id = original.id
          )
        UNION ALL
        SELECT walk.original_id, renewal.id
        FROM walk
        JOIN "${schemaName}".agent_schedules renewal ON renewal.renews_schedule_id = walk.id
      )
      UPDATE "${schemaName}".agent_schedules target
      SET original_schedule_id = walk.original_id
      FROM walk
      WHERE target.id = walk.id
        AND target.id <> walk.original_id
        AND target.original_schedule_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_agent_schedules_original_newest
        ON "${schemaName}".agent_schedules (original_schedule_id, created_at DESC)
        WHERE original_schedule_id IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (235, 'agent_schedules.original_schedule_id, the first schedule of a renewal chain')
      ON CONFLICT (version) DO NOTHING;
  `);
}
