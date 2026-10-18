import type postgres from 'postgres';

/**
 * The coding agent a space prefers on a connected machine (Plan 326 D12): a
 * harness id, or null where the machine decides.
 */
export async function applyMigration225(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS preferred_harness TEXT
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (225, 'Plan 326 D12 — Add preferred_harness column to spaces')
      ON CONFLICT (version) DO NOTHING
    `);
}
