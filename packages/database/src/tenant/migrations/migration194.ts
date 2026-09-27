import type postgres from 'postgres';

/**
 * Host bindings — the operator's declaration of which folders on their own
 * machine a space may reach.
 *
 * Half of the authority, not all of it. The paired executor keeps its own
 * policy file outside any job-writable path, and what applies is the
 * intersection: a row here that the machine does not offer reaches nothing.
 * That is what stops a compromised appliance from inventing access to a folder
 * the operator never connected.
 *
 * `allows_execution` defaults false because reading files and running commands
 * are different grants. A folder connected for its contents should not become a
 * shell by being connected.
 */
export async function applyMigration194(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".host_bindings (
        host_binding_id TEXT NOT NULL,
        space_id UUID NOT NULL,
        label TEXT NOT NULL,
        root TEXT NOT NULL,
        writable BOOLEAN NOT NULL DEFAULT false,
        allows_execution BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (space_id, host_binding_id)
      );

      CREATE INDEX IF NOT EXISTS idx_host_bindings_space
        ON "${schemaName}".host_bindings (space_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (194, 'Host bindings for the host execution lane')
      ON CONFLICT (version) DO NOTHING;
  `);
}
