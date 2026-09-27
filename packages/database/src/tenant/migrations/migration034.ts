/**
 * Tenant migration 34 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration034(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- === Table renames (IF EXISTS makes these idempotent) ===
      ALTER TABLE IF EXISTS "${schemaName}".flow_definitions RENAME TO agent_definitions;
      ALTER TABLE IF EXISTS "${schemaName}".flow_runs RENAME TO sessions;
      ALTER TABLE IF EXISTS "${schemaName}".flow_run_state_snapshots RENAME TO session_state_snapshots;
      ALTER TABLE IF EXISTS "${schemaName}".flow_schedules RENAME TO agent_schedules;
  
      -- === Idempotent column rename helper ===
      -- Each DO block checks if old column exists before renaming,
      -- so the migration is safe to re-run after partial failure.
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_definitions' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".agent_definitions RENAME COLUMN flow_id TO agent_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'sessions' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".sessions RENAME COLUMN run_id TO session_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'sessions' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".sessions RENAME COLUMN flow_id TO agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'sessions' AND column_name = 'flow_version') THEN
          ALTER TABLE "${schemaName}".sessions RENAME COLUMN flow_version TO agent_version;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'step_executions' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".step_executions RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'event_log' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".event_log RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'idempotency_keys' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".idempotency_keys RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'session_state_snapshots' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".session_state_snapshots RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_docs' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".memory_docs RENAME COLUMN flow_id TO agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_docs' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".memory_docs RENAME COLUMN run_id TO session_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_docs' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".memory_docs RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_doc_versions' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".memory_doc_versions RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_dirs' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".memory_dirs RENAME COLUMN flow_id TO agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_dirs' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".memory_dirs RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_entries' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".memory_entries RENAME COLUMN flow_id TO agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'memory_entries' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".memory_entries RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'guardrail_violations' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".guardrail_violations RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'guardrail_checks' AND column_name = 'run_id') THEN
          ALTER TABLE "${schemaName}".guardrail_checks RENAME COLUMN run_id TO session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'ui_artifacts' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".ui_artifacts RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'ui_artifact_versions' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".ui_artifact_versions RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'ui_artifact_drafts' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".ui_artifact_drafts RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'flow_id') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN flow_id TO agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'flow_version') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN flow_version TO agent_version;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'target_run_id') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN target_run_id TO target_session_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'source_flow_id') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN source_flow_id TO source_agent_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'last_run_id') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN last_run_id TO last_session_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'agent_schedules' AND column_name = 'created_by_run_id') THEN
          ALTER TABLE "${schemaName}".agent_schedules RENAME COLUMN created_by_run_id TO created_by_session_id;
        END IF;
      END $$;
  
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName}' AND table_name = 'spaces' AND column_name = 'default_flow_id') THEN
          ALTER TABLE "${schemaName}".spaces RENAME COLUMN default_flow_id TO default_agent_id;
        END IF;
      END $$;
  
      -- === capability profiles: update capability group IDs in JSONB ===
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = (
        SELECT jsonb_agg(
          CASE
            WHEN elem->>'capabilityGroupId' = 'flow.control' THEN jsonb_set(elem, '{capabilityGroupId}', '"agent.control"')
            WHEN elem->>'capabilityGroupId' = 'flow.manage' THEN jsonb_set(elem, '{capabilityGroupId}', '"agent.manage"')
            WHEN elem->>'capabilityGroupId' = 'flow.schedule' THEN jsonb_set(elem, '{capabilityGroupId}', '"agent.schedule"')
            ELSE elem
          END
        )
        FROM jsonb_array_elements(allowed_capabilities) AS elem
      )
      WHERE allowed_capabilities::text LIKE '%flow.%';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (34, 'Plan 90 — Taxonomy reset: flow→agent, run→session (tables, columns, capability groups)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
