import type postgres from 'postgres';

/**
 * Learnings scoped to a plan node, and dependencies between nodes (Plan 322 P2).
 *
 * `coach_learnings.plan_node_id` names the node a `plan`-scope learning was
 * written on. It carries no foreign key, as `campaign_id` carries none: a
 * learning goes with its space, and a node is removed only with its space.
 * Few learnings are plan-scoped, so the index holds only those.
 *
 * A dependency is keyed by the pair, which leads with the waiting node — how
 * a node's dependencies are read. The `(space_id, depends_on_id)` index is how
 * a node's dependents are read, and how a space's edges are deleted.
 */
export async function applyMigration226(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_learnings
        ADD COLUMN IF NOT EXISTS plan_node_id UUID;

      CREATE INDEX IF NOT EXISTS coach_learnings_space_plan_node_idx
        ON "${schemaName}".coach_learnings (space_id, plan_node_id)
        WHERE plan_node_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS "${schemaName}".plan_node_dependencies (
        node_id        UUID NOT NULL REFERENCES "${schemaName}".plan_nodes (id) ON DELETE CASCADE,
        depends_on_id  UUID NOT NULL REFERENCES "${schemaName}".plan_nodes (id) ON DELETE CASCADE,
        space_id       UUID NOT NULL,
        condition      TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (node_id, depends_on_id)
      );

      CREATE INDEX IF NOT EXISTS plan_node_dependencies_space_depends_on_idx
        ON "${schemaName}".plan_node_dependencies (space_id, depends_on_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (226, 'Plan 322 P2 — plan-scope coach learnings and plan_node_dependencies')
      ON CONFLICT (version) DO NOTHING;
  `);
}
