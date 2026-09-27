import type postgres from 'postgres';

export async function applyMigration162(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS spaces_expires_at_idx
        ON "${schemaName}".spaces (expires_at)
        WHERE expires_at IS NOT NULL;

      ALTER TABLE "${schemaName}".eval_batches
        ADD COLUMN IF NOT EXISTS notes TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (162, 'Plan 269 P2 — spaces.expires_at (ephemeral eval fixture spaces) + eval_batches.notes')
      ON CONFLICT (version) DO NOTHING;
    `);
}
