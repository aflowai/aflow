import type postgres from 'postgres';

export async function applyMigration098(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
    BEGIN;

    -- 1. Truncate everything that references the old text agent identity.
    --    CASCADE handles dependent rows (step_executions, run_events, etc).
    --    IF EXISTS on each table — the agent_definitions DROP later in the
    --    migration may have already happened on a previous half-failed run.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = '${schemaName}' AND table_name = 'agent_definitions') THEN
        EXECUTE 'TRUNCATE "${schemaName}".agent_definitions CASCADE';
      END IF;
    END $$;
    TRUNCATE
      "${schemaName}".sessions,
      "${schemaName}".memory_entries,
      "${schemaName}".memory_docs,
      "${schemaName}".memory_dirs,
      "${schemaName}".agent_schedules,
      "${schemaName}".webhook_endpoints,
      "${schemaName}".event_log
    RESTART IDENTITY CASCADE;

    -- 2. Drop the old agent_definitions table (replaced by agents + agent_versions).
    --    CASCADE drops the dependent FK constraint on sessions(agent_id, agent_version)
    --    created in migration001 (auto-named, hence the cascade rather than IF EXISTS).
    DROP TABLE IF EXISTS "${schemaName}".agent_definitions CASCADE;

    -- 3. Identity row — CUSTOM AGENTS ONLY.
    --    Platform roles (cybernetic-helmsman/-runner/-coach) are not modelled
    --    as agents; they live in packages/platform-artifacts and are resolved
    --    by (spaceId, systemRole) at runtime. No system_role column on the
    --    agents table, no per-space platform-agent rows.
    CREATE TABLE IF NOT EXISTS "${schemaName}".agents (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id    uuid NOT NULL REFERENCES "${schemaName}".spaces(id) ON DELETE CASCADE,
      slug        text NOT NULL,
      name        text NOT NULL,
      description text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      UNIQUE (space_id, slug)
    );

    CREATE INDEX IF NOT EXISTS agents_space_id_idx ON "${schemaName}".agents (space_id);

    -- 4. Immutable versioned artifacts (was agent_definitions).
    CREATE TABLE IF NOT EXISTS "${schemaName}".agent_versions (
      agent_id        uuid NOT NULL REFERENCES "${schemaName}".agents(id) ON DELETE CASCADE,
      version         text NOT NULL,
      definition_json jsonb NOT NULL,
      status          text NOT NULL DEFAULT 'published',
      created_by      text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, version)
    );

    CREATE INDEX IF NOT EXISTS agent_versions_status_idx ON "${schemaName}".agent_versions (status);

    -- 5. Slug history — link durability across renames.
    --    space_slug_history is tenant-scoped by virtue of living in the per-tenant schema.
    --    agent_slug_history is space-scoped via the (space_id, old_slug) UNIQUE constraint.
    CREATE TABLE IF NOT EXISTS "${schemaName}".space_slug_history (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id   uuid NOT NULL REFERENCES "${schemaName}".spaces(id) ON DELETE CASCADE,
      old_slug   text NOT NULL,
      new_slug   text NOT NULL,
      renamed_at timestamptz NOT NULL DEFAULT now(),
      renamed_by uuid,
      UNIQUE (old_slug)
    );

    CREATE TABLE IF NOT EXISTS "${schemaName}".agent_slug_history (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id   uuid NOT NULL REFERENCES "${schemaName}".agents(id) ON DELETE CASCADE,
      space_id   uuid NOT NULL REFERENCES "${schemaName}".spaces(id) ON DELETE CASCADE,
      old_slug   text NOT NULL,
      new_slug   text NOT NULL,
      renamed_at timestamptz NOT NULL DEFAULT now(),
      renamed_by uuid,
      UNIQUE (space_id, old_slug)
    );

    -- 6. Migrate dependent tables. Tables were truncated above; DROP+ADD
    --    COLUMN is cleaner than ALTER … USING.

    -- sessions: tagged AgentTarget — platform-role, custom-agent, or inline-agent.
    ALTER TABLE "${schemaName}".sessions DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".sessions ADD COLUMN IF NOT EXISTS target_kind text;
    ALTER TABLE "${schemaName}".sessions ADD COLUMN IF NOT EXISTS target_system_role text;
    ALTER TABLE "${schemaName}".sessions ADD COLUMN IF NOT EXISTS target_agent_id uuid;
    ALTER TABLE "${schemaName}".sessions ADD COLUMN IF NOT EXISTS target_inline_def_ref text;
    -- target_kind must be NOT NULL for sessions. Tighten after the column exists.
    UPDATE "${schemaName}".sessions SET target_kind = 'platform-role' WHERE target_kind IS NULL;
    ALTER TABLE "${schemaName}".sessions ALTER COLUMN target_kind SET NOT NULL;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".sessions ADD CONSTRAINT sessions_target_kind_check
        CHECK (
          (target_kind = 'platform-role' AND target_system_role IS NOT NULL AND target_agent_id IS NULL     AND target_inline_def_ref IS NULL) OR
          (target_kind = 'custom-agent'  AND target_system_role IS NULL     AND target_agent_id IS NOT NULL AND target_inline_def_ref IS NULL) OR
          (target_kind = 'inline-agent'  AND target_system_role IS NULL     AND target_agent_id IS NULL     AND target_inline_def_ref IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_sessions_target_agent_id
      ON "${schemaName}".sessions (target_agent_id)
      WHERE target_agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_target_system_role
      ON "${schemaName}".sessions (target_system_role)
      WHERE target_system_role IS NOT NULL;

    -- memory_entries: nullable agent scope. Recreate the scope-check CHECK and
    -- the NULLS-NOT-DISTINCT unique index that migration001 originally added
    -- (both reference agent_id and were dropped with the column).
    ALTER TABLE "${schemaName}".memory_entries DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".memory_entries ADD COLUMN IF NOT EXISTS agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE SET NULL;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".memory_entries
        ADD CONSTRAINT memory_entries_scope_check CHECK (
          (space_id IS NOT NULL AND agent_id IS NULL AND session_id IS NULL) OR
          (space_id IS NULL AND agent_id IS NOT NULL AND session_id IS NULL) OR
          (space_id IS NULL AND agent_id IS NULL AND session_id IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_unique_scope
      ON "${schemaName}".memory_entries (namespace, key, space_id, agent_id, session_id)
      NULLS NOT DISTINCT;
    CREATE INDEX IF NOT EXISTS idx_memory_entries_agent_id
      ON "${schemaName}".memory_entries (agent_id)
      WHERE agent_id IS NOT NULL;

    -- memory_docs: nullable agent scope
    ALTER TABLE "${schemaName}".memory_docs DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".memory_docs ADD COLUMN IF NOT EXISTS agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_docs_agent_id ON "${schemaName}".memory_docs (agent_id)
      WHERE agent_id IS NOT NULL;

    -- memory_dirs: nullable agent scope
    ALTER TABLE "${schemaName}".memory_dirs DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".memory_dirs ADD COLUMN IF NOT EXISTS agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_dirs_agent_id ON "${schemaName}".memory_dirs (agent_id)
      WHERE agent_id IS NOT NULL;

    -- spaces.default_target: tagged AgentTarget (nullable — a space may have
    --    no default at all). For cybernetic spaces the typical default is the
    --    platform helmsman; for non-cybernetic spaces it's optionally a
    --    custom agent.
    ALTER TABLE "${schemaName}".spaces DROP COLUMN IF EXISTS default_agent_id;
    ALTER TABLE "${schemaName}".spaces ADD COLUMN IF NOT EXISTS default_target_kind text;
    ALTER TABLE "${schemaName}".spaces ADD COLUMN IF NOT EXISTS default_target_system_role text;
    ALTER TABLE "${schemaName}".spaces ADD COLUMN IF NOT EXISTS default_target_agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE SET NULL;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".spaces ADD CONSTRAINT spaces_default_target_kind_check
        CHECK (
          (default_target_kind IS NULL AND default_target_system_role IS NULL AND default_target_agent_id IS NULL) OR
          (default_target_kind = 'platform-role' AND default_target_system_role IS NOT NULL AND default_target_agent_id IS NULL) OR
          (default_target_kind = 'custom-agent'  AND default_target_system_role IS NULL     AND default_target_agent_id IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- agent_schedules: tagged AgentTarget. Schedules with action='start_run'
    --    require a real target (platform-role or custom-agent). Schedules
    --    with action='resume_run' target a session via target_session_id
    --    instead, so the agent-target columns are all-NULL there. The CHECK
    --    permits all-NULL together for the resume_run case.
    ALTER TABLE "${schemaName}".agent_schedules DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS target_kind text;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS target_system_role text;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS target_agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE CASCADE;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".agent_schedules ADD CONSTRAINT agent_schedules_target_kind_check
        CHECK (
          (target_kind IS NULL AND target_system_role IS NULL AND target_agent_id IS NULL) OR
          (target_kind = 'platform-role' AND target_system_role IS NOT NULL AND target_agent_id IS NULL) OR
          (target_kind = 'custom-agent'  AND target_system_role IS NULL     AND target_agent_id IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- agent_schedules.source: tagged AgentTarget (NULLABLE — only set for chained schedules).
    --    source_kind can be NULL together with both source_* targets when the
    --    schedule wasn't created by an agent.
    ALTER TABLE "${schemaName}".agent_schedules DROP COLUMN IF EXISTS source_agent_id;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS source_kind text;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS source_system_role text;
    ALTER TABLE "${schemaName}".agent_schedules ADD COLUMN IF NOT EXISTS source_agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE SET NULL;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".agent_schedules ADD CONSTRAINT agent_schedules_source_kind_check
        CHECK (
          (source_kind IS NULL AND source_system_role IS NULL AND source_agent_id IS NULL) OR
          (source_kind = 'platform-role' AND source_system_role IS NOT NULL AND source_agent_id IS NULL) OR
          (source_kind = 'custom-agent'  AND source_system_role IS NULL     AND source_agent_id IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- webhook_endpoints: tagged AgentTarget (NOT NULL — every webhook targets something).
    ALTER TABLE "${schemaName}".webhook_endpoints DROP COLUMN IF EXISTS agent_id;
    ALTER TABLE "${schemaName}".webhook_endpoints ADD COLUMN IF NOT EXISTS target_kind text;
    ALTER TABLE "${schemaName}".webhook_endpoints ADD COLUMN IF NOT EXISTS target_system_role text;
    ALTER TABLE "${schemaName}".webhook_endpoints ADD COLUMN IF NOT EXISTS target_agent_id uuid
      REFERENCES "${schemaName}".agents(id) ON DELETE CASCADE;
    -- target_kind must be NOT NULL for webhook_endpoints. Tighten after the column exists.
    UPDATE "${schemaName}".webhook_endpoints SET target_kind = 'platform-role' WHERE target_kind IS NULL;
    ALTER TABLE "${schemaName}".webhook_endpoints ALTER COLUMN target_kind SET NOT NULL;
    DO $$
    BEGIN
      ALTER TABLE "${schemaName}".webhook_endpoints ADD CONSTRAINT webhook_endpoints_target_kind_check
        CHECK (
          (target_kind = 'platform-role' AND target_system_role IS NOT NULL AND target_agent_id IS NULL) OR
          (target_kind = 'custom-agent'  AND target_system_role IS NULL     AND target_agent_id IS NOT NULL)
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- 7. Record migration.
    INSERT INTO "${schemaName}".schema_migrations (version, description)
    VALUES (98, 'Plan 160 — agent identity/slug split + slug history tables')
    ON CONFLICT (version) DO NOTHING;

    COMMIT;
  `);
}
