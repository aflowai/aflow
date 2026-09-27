import type postgres from 'postgres';

/**
 * Conversation titles, summaries, and an activity clock on `sessions`.
 *
 * Columns rather than a side table: the projection worker's conflict-update
 * names exactly the columns it owns, so a column it does not name cannot be
 * clobbered by a stale snapshot — and keeping them here spares every listing
 * a join, spares metadata initialization the race with a session row that has
 * not been projected yet, and inherits the session purge already keyed on
 * `sessions.session_id`.
 *
 * `title` and `manual_title` are separate on purpose. A generation landing
 * after someone renamed the conversation writes the column nobody read, so the
 * two writers never contend and no optimistic retry is needed between them;
 * the resolved title is simply `manual_title` where there is one.
 *
 * `last_activity_at` starts life equal to `started_at` for existing rows. The
 * alternative — leaving it null and ordering on a COALESCE — needs an
 * expression index to stay fast and reads as two different clocks depending on
 * the row's age.
 */
export async function applyMigration205(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS title TEXT,
        ADD COLUMN IF NOT EXISTS title_state TEXT,
        ADD COLUMN IF NOT EXISTS manual_title TEXT,
        ADD COLUMN IF NOT EXISTS summary TEXT,
        ADD COLUMN IF NOT EXISTS summary_coverage TEXT,
        ADD COLUMN IF NOT EXISTS metadata_revision INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS metadata_evidence_revision INTEGER,
        ADD COLUMN IF NOT EXISTS metadata_updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS metadata_edited_by UUID,
        ADD COLUMN IF NOT EXISTS metadata_json JSONB,
        ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

      UPDATE "${schemaName}".sessions
        SET last_activity_at = started_at
        WHERE last_activity_at IS NULL;

      ALTER TABLE "${schemaName}".sessions
        ALTER COLUMN last_activity_at SET DEFAULT NOW();

      CREATE INDEX IF NOT EXISTS idx_sessions_space_activity
        ON "${schemaName}".sessions (space_id, last_activity_at DESC, session_id DESC);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (205, 'Session titles, summaries, and a conversation activity clock')
      ON CONFLICT (version) DO NOTHING;
  `);
}
