import type postgres from 'postgres';

/**
 * The concurrency policy a run executes under, pinned at creation alongside
 * `workflow_revision`.
 *
 * Re-resolving the skill manifest at dispatch time would let an edit landing
 * mid-run change the limits of a run already in flight. The pinned revision
 * exists so a run's contract is frozen; concurrency is part of that contract.
 *
 * NULL means the run predates the column — readers fall back to the schema
 * defaults.
 */
export async function applyMigration178(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS effective_concurrency_policy JSONB;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (178, 'Pin the effective concurrency policy on the run row')
      ON CONFLICT (version) DO NOTHING;
    `);
}
