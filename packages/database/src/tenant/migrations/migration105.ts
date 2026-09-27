import type postgres from 'postgres';

export async function applyMigration105(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".campaigns (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id          UUID NOT NULL,
        workflow_slug     TEXT NOT NULL,
        goal_ref          TEXT NOT NULL,
        score_metric_key  TEXT NOT NULL,
        direction         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at          TIMESTAMPTZ,
        ended_reason      TEXT
      );

      -- At most one active campaign per identity tuple.
      CREATE UNIQUE INDEX IF NOT EXISTS campaigns_active_identity_idx
        ON "${schemaName}".campaigns (space_id, workflow_slug, goal_ref)
        WHERE status = 'active';

      CREATE INDEX IF NOT EXISTS campaigns_space_workflow_started_idx
        ON "${schemaName}".campaigns (space_id, workflow_slug, started_at DESC);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (105, 'Plan 183e §0 — campaigns table (campaign identity)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
