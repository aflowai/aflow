import type postgres from 'postgres';

export async function applyMigration165(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DROP INDEX IF EXISTS "${schemaName}".eval_labels_case_scoped_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS eval_labels_case_scoped_idx
        ON "${schemaName}".eval_labels (space_id, batch_id, case_revision_id, trial, criterion_id, scope_key, partition)
        WHERE case_revision_id IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (165, 'Plan 269 P3 — case-scoped label identity is per batch trial and per partition')
      ON CONFLICT (version) DO NOTHING;
    `);
}
