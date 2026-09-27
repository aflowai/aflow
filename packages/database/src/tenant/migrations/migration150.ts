/**
 * Applet instances get first-class identity: the instance row is the row lock
 * that serializes every action, the journal is the append-only receipt log
 * doubling as the transactional outbox for post-commit effects, and role
 * bindings are typed rows so membership is visible to the erasure cascade.
 * The definition is colocated with the artifact version so contract and view
 * advance together.
 */
import type postgres from 'postgres';

export async function applyMigration150(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".applet_instances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id uuid NOT NULL,
        applet_key text NOT NULL,
        definition_hash text NOT NULL,
        artifact_version_id uuid NOT NULL REFERENCES "${schemaName}".ui_artifact_versions(id),
        state_path text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        bound_session_id uuid,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_applet_instances_space_status
        ON "${schemaName}".applet_instances (space_id, status);

      CREATE TABLE IF NOT EXISTS "${schemaName}".applet_action_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id uuid NOT NULL REFERENCES "${schemaName}".applet_instances(id),
        seq integer NOT NULL,
        action_id uuid NOT NULL,
        actor_user_id uuid,
        actor_agent_role text,
        action_name text NOT NULL,
        input jsonb NOT NULL DEFAULT '{}'::jsonb,
        patch jsonb NOT NULL DEFAULT '[]'::jsonb,
        outcome text,
        effects jsonb NOT NULL,
        before_version integer NOT NULL,
        after_version integer NOT NULL,
        delivered_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT applet_action_events_seq_unique UNIQUE (instance_id, seq),
        CONSTRAINT applet_action_events_action_unique UNIQUE (instance_id, action_id)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".applet_role_bindings (
        instance_id uuid NOT NULL REFERENCES "${schemaName}".applet_instances(id),
        user_id uuid NOT NULL,
        role text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (instance_id, user_id, role)
      );

      ALTER TABLE "${schemaName}".ui_artifact_versions
        ADD COLUMN IF NOT EXISTS applet_definition jsonb,
        ADD COLUMN IF NOT EXISTS definition_hash text;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (150, 'Applets: instances + action journal/outbox + role bindings; definition colocated on ui_artifact_versions')
      ON CONFLICT (version) DO NOTHING;
    `);
}
