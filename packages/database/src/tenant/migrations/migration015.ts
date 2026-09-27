/**
 * Tenant migration 15 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration015(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".guardrail_policies (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_id       TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        description     TEXT,
        version         TEXT NOT NULL DEFAULT '1',
        scope           JSONB NOT NULL,
        rails           JSONB NOT NULL,
        settings        JSONB,
        tags            TEXT[],
        space_id        UUID,
        created_by      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".guardrail_violations (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id        TEXT NOT NULL,
        step_execution_id TEXT,
        policy_id         TEXT NOT NULL,
        rail_id           TEXT NOT NULL,
        trigger           TEXT NOT NULL,
        violation_type    TEXT NOT NULL,
        action_taken      TEXT NOT NULL,
        detail            JSONB,
        duration_ms       INTEGER,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_guardrail_violations_session
        ON "${schemaName}".guardrail_violations(session_id);
      CREATE INDEX IF NOT EXISTS idx_guardrail_violations_policy
        ON "${schemaName}".guardrail_violations(policy_id);
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".guardrail_checks (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id        TEXT NOT NULL,
        step_execution_id TEXT,
        policy_id         TEXT NOT NULL,
        rail_id           TEXT NOT NULL,
        trigger           TEXT NOT NULL,
        layer             TEXT NOT NULL,
        result            TEXT NOT NULL,
        action_taken      TEXT,
        detail            JSONB,
        duration_ms       INTEGER NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_guardrail_checks_session
        ON "${schemaName}".guardrail_checks(session_id);
      CREATE INDEX IF NOT EXISTS idx_guardrail_checks_created
        ON "${schemaName}".guardrail_checks(created_at);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (15, 'Plan 38 Phase 1 — guardrail policies, violations, checks')
      ON CONFLICT (version) DO NOTHING;
    `);
}
