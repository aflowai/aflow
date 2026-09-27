/**
 * Tenant migration 56 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration056(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".user_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        free_text TEXT,
        created_by_user_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
  
      CREATE INDEX IF NOT EXISTS user_feedback_subject_idx
        ON "${schemaName}".user_feedback (space_id, subject_kind, subject_id);
      CREATE INDEX IF NOT EXISTS user_feedback_space_time_idx
        ON "${schemaName}".user_feedback (space_id, created_at DESC);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (56, 'Plan 104e Phase 3 — user_feedback table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
