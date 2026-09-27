import type postgres from 'postgres';

/**
 * Record which branches a connected folder may be pushed to.
 *
 * A fact about the folder, like `allows_execution`: connecting one for commands
 * says nothing about whether its history may be published, and the two grants
 * are made separately for that reason. Null — the default every existing row
 * takes — means the folder pushes nothing.
 *
 * The machine holds the same declaration in its own policy file and enforces
 * it there, so this column is the workspace's half of a grant rather than the
 * thing that authorises a push.
 */
export async function applyMigration209(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".host_bindings
        ADD COLUMN IF NOT EXISTS branch_prefix text;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (209, 'Connected folders record which branches they may be pushed to')
      ON CONFLICT (version) DO NOTHING;
  `);
}
