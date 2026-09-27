import type postgres from 'postgres';

/**
 * Give a golden case somewhere to keep its requirements.
 *
 * A case declares requirements and its checks claim them by id — that
 * separation is the point of the design, because a gate deriving what to test
 * from the checks under test cannot notice a missing check. The table never
 * had a column for them: the writer dropped `requirements` on the floor, the
 * reader rebuilt the case without them, and the schema's own cross-field rule
 * then refused any check whose `claims` named one. A case that declared a
 * requirement could not be read back.
 *
 * It failed loudly and late. `rowToCaseRevision` parses inside a map, so one
 * unreadable row failed the whole dataset read and every eval batch for that
 * skill with it — the first attempt to run a suite end to end could not launch.
 *
 * Existing rows backfill to `[]`, which is what they have been behaving as.
 * Claims left dangling by the old write path are dropped in the same pass:
 * the requirement they named is not recoverable, and a claim pointing at
 * nothing is what made the row unreadable.
 */
export async function applyMigration206(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Separate calls on purpose. A second statement in one `unsafe` did not run
  // here — the column appeared and the repair silently did not, with the
  // migration recorded as applied either way, which is the worst shape a
  // migration can fail in.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".golden_case_revisions
        ADD COLUMN IF NOT EXISTS requirements_json jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);

  // Matched by key, not by text: `claims` occurs as an ordinary word in rubric
  // prose, and a LIKE over the serialized column rewrites rows that were never
  // broken while missing the shape it meant to catch.
  for (const column of ['expectations_json', 'rubrics_json']) {
    await sqlClient.unsafe(`
        UPDATE "${schemaName}".golden_case_revisions r
        SET ${column} = (
          SELECT COALESCE(jsonb_agg(x - 'claims'), '[]'::jsonb)
          FROM jsonb_array_elements(r.${column}) x
        )
        WHERE r.requirements_json = '[]'::jsonb
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(r.${column}) x WHERE x ? 'claims'
          );
    `);
  }

  // The runner gates on this row, so a migration that does not write it runs
  // again on every startup — here re-scanning every case of every tenant for a
  // repair that was already made.
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (206, 'Golden cases keep the requirements they declare')
      ON CONFLICT (version) DO NOTHING;
  `);
}
