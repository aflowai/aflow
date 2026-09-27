import type postgres from 'postgres';

/**
 * Trade the world-version reservation columns for a generated-call counter.
 *
 * The two high-waters existed so a world version could be handed out before a
 * call ran, because entity ids were minted from it. Keying ids on the call's
 * own logical execution id removed that need, and versions are now assigned in
 * the commit transaction, in commit order — so the columns, and the dispatch
 * identity that fed them, have no reader left.
 *
 * `generated_calls` is not the same idea returning. That machinery pre-assigned
 * an ORDER, which had a cheaper answer. This counts SPEND, which does not: a
 * generated answer costs tokens before its journal record exists, so a ceiling
 * read from the journal lets two concurrent calls both see the last remaining
 * slot and both dial the model.
 */
export async function applyMigration191(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".simulation_run_contexts
        DROP COLUMN IF EXISTS reserved_world_version,
        DROP COLUMN IF EXISTS unidentified_world_version,
        ADD COLUMN IF NOT EXISTS generated_calls integer NOT NULL DEFAULT 0;

      DROP INDEX IF EXISTS "${schemaName}".idx_simulation_call_records_dispatch;

      ALTER TABLE "${schemaName}".simulation_call_records
        DROP COLUMN IF EXISTS dispatch_turn,
        DROP COLUMN IF EXISTS dispatch_index,
        DROP COLUMN IF EXISTS dispatch_target_ordinal;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (191, 'Drop world-version reservation and dispatch identity; add generated_calls spend counter')
      ON CONFLICT (version) DO NOTHING;
    `);
}
