/**
 * Tenant migration 1 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration001(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Create tenant tables within the schema
  await sqlClient.unsafe(`
      -- Agent definitions (immutable versioned artifacts)
      CREATE TABLE IF NOT EXISTS "${schemaName}".agent_definitions (
        agent_id TEXT NOT NULL,
        version TEXT NOT NULL,
        name TEXT,
        definition_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
        PRIMARY KEY (agent_id, version)
      );
  
      CREATE INDEX IF NOT EXISTS idx_agent_definitions_status
        ON "${schemaName}".agent_definitions (status);
  
      -- Sessions (agent execution instances)
      CREATE TABLE IF NOT EXISTS "${schemaName}".sessions (
        session_id UUID PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ON_CHILD', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELLING', 'STALLED')),
        start_step_id TEXT,
        current_step_execution_id UUID,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        pause_reason TEXT,
        requested_input_ref TEXT,
        final_output_ref TEXT,
        error_ref TEXT,
        created_by TEXT,
        trace_id TEXT,
        total_cost_cents NUMERIC(12, 4) DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        parent_session_id UUID,
        FOREIGN KEY (agent_id, agent_version) REFERENCES "${schemaName}".agent_definitions(agent_id, version)
      );
  
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON "${schemaName}".sessions (status);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_id
        ON "${schemaName}".sessions (agent_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_created
        ON "${schemaName}".sessions (started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON "${schemaName}".sessions (parent_session_id)
        WHERE parent_session_id IS NOT NULL;
  
      -- Step executions
      CREATE TABLE IF NOT EXISTS "${schemaName}".step_executions (
        step_execution_id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES "${schemaName}".sessions(session_id),
        parent_step_execution_id UUID,
        step_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'STARTED', 'SUCCEEDED', 'FAILED', 'PAUSED')),
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        input_ref TEXT,
        output_ref TEXT,
        error_ref TEXT,
        idempotency_key TEXT NOT NULL,
        cost_json JSONB,
        trace_id TEXT
      );
  
      CREATE INDEX IF NOT EXISTS idx_step_executions_session_id
        ON "${schemaName}".step_executions (session_id);
      CREATE INDEX IF NOT EXISTS idx_step_executions_parent
        ON "${schemaName}".step_executions (session_id, parent_step_execution_id);
      CREATE INDEX IF NOT EXISTS idx_step_executions_status
        ON "${schemaName}".step_executions (session_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_step_executions_idempotency
        ON "${schemaName}".step_executions (step_execution_id, attempt);
  
      -- Durable event log (append-only)
      CREATE TABLE IF NOT EXISTS "${schemaName}".event_log (
        event_id UUID PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        session_id UUID NOT NULL REFERENCES "${schemaName}".sessions(session_id),
        step_execution_id UUID,
        parent_step_execution_id UUID,
        step_id TEXT,
        step_type TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload_ref TEXT,
        error_ref TEXT,
        requested_input_ref TEXT,
        idempotency_key TEXT NOT NULL,
        sequence_number BIGSERIAL
      );
  
      CREATE INDEX IF NOT EXISTS idx_event_log_session_timestamp
        ON "${schemaName}".event_log (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_log_step_attempt
        ON "${schemaName}".event_log (session_id, step_execution_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_event_log_sequence
        ON "${schemaName}".event_log (session_id, sequence_number);
  
      -- Idempotency keys for request deduplication
      CREATE TABLE IF NOT EXISTS "${schemaName}".idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_id UUID,
        step_execution_id UUID,
        result_ref TEXT,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
      );
  
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
        ON "${schemaName}".idempotency_keys (expires_at);
  
      -- Session state snapshots (optional but recommended)
      CREATE TABLE IF NOT EXISTS "${schemaName}".session_state_snapshots (
        session_id UUID NOT NULL REFERENCES "${schemaName}".sessions(session_id),
        snapshot_seq INTEGER NOT NULL,
        state_ref TEXT,
        state_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, snapshot_seq)
      );
  
      -- Memory entries (key-value storage with optional TTL, metadata, vector search)
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace TEXT NOT NULL DEFAULT 'default',
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        metadata JSONB,
        session_id UUID,
        user_id TEXT,
        space_id UUID,
        agent_id TEXT,
        content_ref TEXT,
        content_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        embedding JSONB,
        embedding_model TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK (embedding_status IN ('pending', 'ready', 'failed', 'disabled')),
        embedded_at TIMESTAMPTZ,
        embed_error JSONB,
        content_hash TEXT,
        -- Ensure exactly one scope field is set (no unscoped entries allowed)
        CONSTRAINT memory_entries_scope_check CHECK (
          (space_id IS NOT NULL AND agent_id IS NULL AND session_id IS NULL) OR
          (space_id IS NULL AND agent_id IS NOT NULL AND session_id IS NULL) OR
          (space_id IS NULL AND agent_id IS NULL AND session_id IS NOT NULL)
        )
      );
  
      -- Scope-aware unique constraint: namespace + key + scope fields
      -- NULLS NOT DISTINCT ensures NULLs are treated as equal for uniqueness
      -- This prevents duplicates when the same scope is set (other columns are NULL)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_unique_scope 
        ON "${schemaName}".memory_entries (namespace, key, space_id, agent_id, session_id)
        NULLS NOT DISTINCT;
  
      CREATE INDEX IF NOT EXISTS idx_memory_entries_namespace_key 
        ON "${schemaName}".memory_entries (namespace, key);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_session_id
        ON "${schemaName}".memory_entries (session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_entries_space_id
        ON "${schemaName}".memory_entries (space_id) WHERE space_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_entries_agent_id
        ON "${schemaName}".memory_entries (agent_id) WHERE agent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_entries_expires 
        ON "${schemaName}".memory_entries (expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_entries_key_prefix 
        ON "${schemaName}".memory_entries (namespace, key text_pattern_ops);
  
      -- Schema migrations tracking
      CREATE TABLE IF NOT EXISTS "${schemaName}".schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        description TEXT
      );
  
      -- Record initial migration
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (1, 'Initial tenant schema creation')
      ON CONFLICT (version) DO NOTHING;
  
    `);
}
