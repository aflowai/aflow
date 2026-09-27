import type postgres from 'postgres';

/**
 * Simulated fulfillment for API bindings: the declaration on the binding, the
 * simulation artifact with its versioned seed world, and the per-call journal.
 *
 * `fulfillment_mode` and `simulation_id` are first-class columns rather than a
 * JSONB corner because several read paths branch on them and one of them is
 * the egress boundary. The CHECK constraint states the enum and the two-column
 * agreement in one predicate, so neither column can hold a value the other
 * contradicts.
 */
export async function applyMigration184(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".api_bindings
        ADD COLUMN IF NOT EXISTS fulfillment_mode text NOT NULL DEFAULT 'live';
      ALTER TABLE "${schemaName}".api_bindings
        ADD COLUMN IF NOT EXISTS simulation_id text;
      ALTER TABLE "${schemaName}".api_bindings
        DROP CONSTRAINT IF EXISTS api_bindings_fulfillment_check;
      ALTER TABLE "${schemaName}".api_bindings
        ADD CONSTRAINT api_bindings_fulfillment_check CHECK (
          (fulfillment_mode = 'live' AND simulation_id IS NULL)
          OR (fulfillment_mode = 'simulated' AND simulation_id IS NOT NULL)
        );

      CREATE TABLE IF NOT EXISTS "${schemaName}".simulations (
        simulation_id    text NOT NULL,
        space_id         uuid NOT NULL,
        name             text NOT NULL,
        description      text,
        revision         integer NOT NULL DEFAULT 1,
        target_api_id    text NOT NULL,
        definition_json  jsonb NOT NULL,
        enabled          integer NOT NULL DEFAULT 1,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (simulation_id, space_id)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".simulation_baselines (
        simulation_id  text NOT NULL,
        space_id       uuid NOT NULL,
        version        integer NOT NULL,
        description    text,
        entity_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (simulation_id, space_id, version)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".simulation_entities (
        space_id       uuid NOT NULL,
        simulation_id  text NOT NULL,
        version        integer NOT NULL,
        collection     text NOT NULL,
        entity_id      text NOT NULL,
        body_json      jsonb NOT NULL,
        PRIMARY KEY (space_id, simulation_id, version, collection, entity_id)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".simulation_call_records (
        space_id              uuid NOT NULL,
        run_id                text NOT NULL,
        logical_execution_id  text NOT NULL,
        simulation_id         text NOT NULL,
        binding_id            text NOT NULL,
        api_id                text NOT NULL,
        endpoint_id           text NOT NULL,
        request_json          jsonb NOT NULL,
        matched_json          jsonb NOT NULL,
        response_status       integer NOT NULL,
        response_ref          text NOT NULL,
        delta_ref             text,
        ordinal               integer NOT NULL,
        world_version_before  integer NOT NULL,
        world_version_after   integer NOT NULL,
        clock_ms              bigint NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (space_id, run_id, logical_execution_id)
      );

      CREATE INDEX IF NOT EXISTS idx_simulation_call_records_run
        ON "${schemaName}".simulation_call_records (space_id, run_id, ordinal);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (184, 'Simulated binding fulfillment — simulations, baselines, entities, call journal')
      ON CONFLICT (version) DO NOTHING;
    `);
}
