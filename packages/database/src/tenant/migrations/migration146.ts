/**
 * Separate the three identities a shared session conflates.
 *
 * A session carried one `created_by`, which stood in for who started it, who
 * is steering it now, and whose authority the agent acts under. Those come
 * apart the moment a second person can act on the same run: taking over the
 * wheel must not silently re-point the credentials and policy the agent
 * executes with, and a run whose authority owner has left the space must stop
 * rather than keep acting under a principal that no longer holds access.
 *
 * `created_by` stays as provenance. Nothing is backfilled — historical rows
 * predate the distinction and inventing an authority for them would assert
 * something that was never evaluated.
 */
import type postgres from 'postgres';

export async function applyMigration146(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS initiated_by uuid,
        ADD COLUMN IF NOT EXISTS current_driver_user_id uuid,
        ADD COLUMN IF NOT EXISTS current_driver_claimed_at timestamptz,
        ADD COLUMN IF NOT EXISTS execution_authority jsonb;

      -- Read pattern is "the runs this person is driving", which is a small
      -- slice of a space's sessions.
      CREATE INDEX IF NOT EXISTS sessions_current_driver_idx
        ON "${schemaName}".sessions (space_id, current_driver_user_id)
        WHERE current_driver_user_id IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (146, 'Session principals — initiated_by, current driver, and a durable execution-authority snapshot')
      ON CONFLICT (version) DO NOTHING;
    `);
}
