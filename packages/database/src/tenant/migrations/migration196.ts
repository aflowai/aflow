import type postgres from 'postgres';

/**
 * Record which local MCP servers a connected folder offers.
 *
 * The column carries ids and labels, never a command. What a server id actually
 * runs is declared in the machine's own policy file, which nothing here can
 * write — the same split that keeps a binding from being invented by the
 * appliance. This half exists so the workspace can say a server is there:
 * without it an agent has no way to learn one exists, and a capability nobody
 * can discover is one nobody uses.
 *
 * It hangs off the binding rather than standing alone because a local server
 * runs *in* a folder. Its reach is that folder's, so its existence is that
 * folder's fact.
 */
export async function applyMigration196(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".host_bindings
        ADD COLUMN IF NOT EXISTS mcp_servers jsonb NOT NULL DEFAULT '[]'::jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (196, 'Connected folders record the local MCP servers they offer')
      ON CONFLICT (version) DO NOTHING;
  `);
}
