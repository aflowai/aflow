import type postgres from 'postgres';

/**
 * What execution observed about a run, stamped where it is known.
 *
 * A trial's answer is read from the pause contract's `prompt`, and the harness
 * fills that field with `Provide input for: <task>` when the subject supplied
 * nothing. The text is non-empty, so every downstream reader — the reply
 * expectation, the judge's evidence pack, the outcome fold — takes a
 * placeholder for an answer and grades silence as a response.
 *
 * Inference cannot recover this after the fact: by the time a reader sees the
 * payload the placeholder is indistinguishable from a short reply. The state
 * is recorded at the moment the contract is built instead.
 */
export async function applyMigration202(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS execution_state TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (202, 'workflow_runs.execution_state — silence is recorded where it happens, not inferred from a placeholder')
      ON CONFLICT (version) DO NOTHING;
    `);
}
