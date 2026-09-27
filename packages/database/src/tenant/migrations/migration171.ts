import type postgres from 'postgres';

/**
 * The durable mark that says a run's `on_completion` schedules have been
 * recorded.
 *
 * The occurrence outbox is durable, but durability only helps if the
 * transition that creates its rows is too — a firing recorded best-effort off
 * the terminal write is lost to one database blip with nothing left pointing
 * at it. Recording inside the transaction that sets this column makes the two
 * commit together, which is
 * what lets the projection of a terminal run be retried without firing twice:
 * a rollback leaves the column null and the retry recomputes the identical
 * occurrence keys.
 *
 * Backfilled as already-fired for every run that is already terminal. These
 * runs fired — or lost — their schedules under the old path, and seeding them
 * unfired would re-fire the entire history on the first pass after install.
 */
export async function applyMigration171(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS completion_schedules_fired_at TIMESTAMPTZ;

      UPDATE "${schemaName}".sessions
         SET completion_schedules_fired_at = COALESCE(ended_at, now())
       WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
         AND completion_schedules_fired_at IS NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (171, 'Durable mark that a terminal run''s on_completion schedules were recorded')
      ON CONFLICT (version) DO NOTHING;
    `);
}
