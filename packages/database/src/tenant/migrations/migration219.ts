import type postgres from 'postgres';

/**
 * `workflow_runs.plan_node_id` and `plan_node_links` (Plan 322 P1).
 *
 * A run names the plan node it serves, so the attention block groups it under
 * that node and a node's runs are read rather than kept by hand. Most runs
 * serve none, so the index holds only those that do.
 *
 * A link is keyed by what it points at — node, kind and ref — so one record is
 * linked to a node once. That key leads with `node_id`, which is how a node's
 * links are read; the `space_id` index is how a space's are deleted.
 */
export async function applyMigration219(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS plan_node_id UUID;

      CREATE INDEX IF NOT EXISTS workflow_runs_plan_node_idx
        ON "${schemaName}".workflow_runs (plan_node_id)
        WHERE plan_node_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS "${schemaName}".plan_node_links (
        node_id     UUID NOT NULL REFERENCES "${schemaName}".plan_nodes (id) ON DELETE CASCADE,
        space_id    UUID NOT NULL,
        kind        TEXT NOT NULL,
        ref         TEXT NOT NULL,
        label       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (node_id, kind, ref)
      );

      CREATE INDEX IF NOT EXISTS plan_node_links_space_node_idx
        ON "${schemaName}".plan_node_links (space_id, node_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (219, 'Plan 322 P1 — workflow_runs.plan_node_id and plan_node_links')
      ON CONFLICT (version) DO NOTHING;
  `);
}
