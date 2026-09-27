/**
 * The decision plane routes attention to people; these two tables are where
 * that routing lives.
 *
 * An assignment says who a request is currently being asked of — attention,
 * never authority, which is why it is a separate row rather than a change to
 * the request. The outbox records who was told about what, exactly once: the
 * unique tuple is the idempotency, so a pause that flushes twice or a
 * reassignment retried does not tell anyone twice.
 */
import type postgres from 'postgres';

export async function applyMigration149(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".action_item_assignments (
        item_id text PRIMARY KEY,
        space_id uuid NOT NULL,
        assignee_user_id uuid NOT NULL,
        assigned_by uuid,
        reason text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_action_item_assignments_assignee
        ON "${schemaName}".action_item_assignments (assignee_user_id);

      CREATE TABLE IF NOT EXISTS "${schemaName}".notification_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id uuid NOT NULL,
        recipient_user_id uuid NOT NULL,
        kind text NOT NULL,
        subject_kind text NOT NULL,
        subject_id text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz,
        CONSTRAINT notification_outbox_dedupe UNIQUE (kind, subject_id, recipient_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_notification_outbox_recipient
        ON "${schemaName}".notification_outbox (recipient_user_id, created_at DESC);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (149, 'Decision plane: item assignments + person-routed notification outbox')
      ON CONFLICT (version) DO NOTHING;
    `);
}
