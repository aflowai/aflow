import type postgres from 'postgres';

export async function applyMigration130(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".coach_learnings (
        id               UUID PRIMARY KEY,
        coach_session_id UUID NOT NULL,
        run_id           UUID,
        space_id         UUID NOT NULL,
        scope_kind       TEXT NOT NULL,
        campaign_id      UUID,
        skill_slug       TEXT,
        kind             TEXT NOT NULL,
        statement        TEXT NOT NULL,
        evidence         JSONB NOT NULL,
        confidence       TEXT NOT NULL,
        supersedes       JSONB NOT NULL DEFAULT '[]',
        authority_level  TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'auto_recorded',
        resolved_at      TIMESTAMPTZ,
        resolved_by      TEXT,
        promoted_from    JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS coach_learnings_scope_idx
        ON "${schemaName}".coach_learnings (space_id, scope_kind, skill_slug, status);

      CREATE INDEX IF NOT EXISTS coach_learnings_space_status_created_idx
        ON "${schemaName}".coach_learnings (space_id, status, created_at DESC);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (130, 'Plan 234 A1 — coach_learnings table (durable learnings move off memory docs)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
