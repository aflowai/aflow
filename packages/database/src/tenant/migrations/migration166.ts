import type postgres from 'postgres';

export async function applyMigration166(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_baselines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        workflow_slug TEXT NOT NULL,
        batch_id UUID NOT NULL,
        pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        pinned_by_user_id UUID
      );
      CREATE UNIQUE INDEX IF NOT EXISTS eval_baselines_identity_idx
        ON "${schemaName}".eval_baselines (space_id, workflow_slug);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (166, 'Plan 269 P4 — eval_baselines: one pinned baseline batch per (space, workflow)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
