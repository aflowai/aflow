import type postgres from 'postgres';

/**
 * Give a label-queue item somewhere to keep the evidence it is reviewed from.
 *
 * The pack a reviewer reads was rebuilt at read time from the trial run. That
 * run lives in a fixture space collected six hours after the batch, while a
 * queue item waits for a person indefinitely — so every item outlived its own
 * evidence and fell back to the saved exchange alone, without the tool results
 * that settle questions like "is this stated timing one the tools returned".
 *
 * A label read from a narrower pack than the judge's measures the gap in
 * evidence rather than the judge, which is the one thing these labels exist to
 * do. Freezing the pack at mint, while the run is still alive, is what makes an
 * item reviewable for as long as it is listed.
 *
 * Existing rows backfill to NULL and keep the old read path: their runs are
 * already gone, so there is nothing to freeze retroactively.
 */
export async function applyMigration207(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`ALTER TABLE "${schemaName}".eval_label_queue
      ADD COLUMN IF NOT EXISTS evidence_json jsonb;`);

  // The runner gates on this row; without it the migration re-runs forever.
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (207, 'A label-queue item carries the evidence it is reviewed from')
      ON CONFLICT (version) DO NOTHING;
  `);
}
