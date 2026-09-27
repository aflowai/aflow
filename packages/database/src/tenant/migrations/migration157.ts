import type postgres from 'postgres';

/**
 * Durable session roster — membership as a first-class fact. The table is the
 * sole authority (no hot-state mirror); a row grants no access of any kind.
 * `generation` bumps per re-invitation and is the Action Center CAS identity.
 */
export async function applyMigration157(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".session_participants (
        session_id uuid NOT NULL,
        user_id uuid NOT NULL,
        status text NOT NULL,
        invited_by uuid,
        generation integer NOT NULL DEFAULT 1,
        invited_at timestamptz,
        joined_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS session_participants_unique
        ON "${schemaName}".session_participants (session_id, user_id);

      CREATE INDEX IF NOT EXISTS idx_session_participants_user_status
        ON "${schemaName}".session_participants (user_id, status);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (157, 'Session participants — durable roster (invited/joined/declined/left), generation as invitation CAS identity')
      ON CONFLICT (version) DO NOTHING;
    `);
}
