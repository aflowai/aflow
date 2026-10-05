import type postgres from 'postgres';

/**
 * `plan_nodes`, and the `plan.node` capability group that reaches it
 * (Plan 322 P0).
 *
 * A plan is a tree of nodes per space, written by the Helmsman through
 * `plan.node.*`. Every system profile that authors takes read and write —
 * `Personal Safe` included, since it is `Standard` less the execution lanes
 * and a plan executes nothing (migration 217 met the cost of leaving it out);
 * `Read Only` takes read.
 *
 * `plan.read` and `plan.write` go: migration 020 seeded them for a step type
 * that never existed, and they cover no operation.
 */
export async function applyMigration218(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".plan_nodes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id    UUID NOT NULL,
        parent_id   UUID REFERENCES "${schemaName}".plan_nodes (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        goal        TEXT NOT NULL,
        criteria    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        outcome     TEXT,
        note        TEXT,
        revision    INTEGER NOT NULL DEFAULT 1,
        position    INTEGER NOT NULL DEFAULT 0,
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at   TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS plan_nodes_space_status_idx
        ON "${schemaName}".plan_nodes (space_id, status);

      CREATE INDEX IF NOT EXISTS plan_nodes_space_parent_idx
        ON "${schemaName}".plan_nodes (space_id, parent_id);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"plan.node","accessMode":"read"},
          {"capabilityGroupId":"plan.node","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"plan.node","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"plan.node","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"plan.node","accessMode":"read"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET
        allowed_capabilities = COALESCE((
          SELECT jsonb_agg(elem ORDER BY ord)
          FROM jsonb_array_elements(allowed_capabilities) WITH ORDINALITY AS a(elem, ord)
          WHERE elem->>'capabilityGroupId' NOT IN ('plan.read', 'plan.write')
        ), '[]'::jsonb),
        denied_capabilities = COALESCE((
          SELECT jsonb_agg(elem ORDER BY ord)
          FROM jsonb_array_elements(denied_capabilities) WITH ORDINALITY AS d(elem, ord)
          WHERE elem->>'capabilityGroupId' NOT IN ('plan.read', 'plan.write')
        ), '[]'::jsonb)
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"plan.read"}]'::jsonb
        OR allowed_capabilities @> '[{"capabilityGroupId":"plan.write"}]'::jsonb
        OR denied_capabilities @> '[{"capabilityGroupId":"plan.read"}]'::jsonb
        OR denied_capabilities @> '[{"capabilityGroupId":"plan.write"}]'::jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (218, 'Plan 322 P0 — plan_nodes, the plan.node capability group, and the stale plan.read / plan.write groups removed')
      ON CONFLICT (version) DO NOTHING;
  `);
}
