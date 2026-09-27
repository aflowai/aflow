import type postgres from 'postgres';

export async function applyMigration140(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Plan 253 P3 — per-space override of the default write-approval gate.
  // A nullable JSONB blob (absent → all tiers use their built-in default).
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS write_policy JSONB
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (140, 'Plan 253 P3 — Add write_policy column to spaces for per-space write-approval overrides')
      ON CONFLICT (version) DO NOTHING
    `);
}
