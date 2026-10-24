import type postgres from 'postgres';

/**
 * A schedule records the schedule it renews (Plan 315).
 *
 * `agent_schedules.renews_schedule_id` names the predecessor a renewal took
 * over from. A renewal is the same trigger continuing, not a new one armed, so
 * whatever reads a row as news of an arming reads this first. It carries no
 * foreign key: a schedule is soft-deleted, never removed from under its
 * successor. The unique index is the database's statement that a schedule has
 * one successor.
 */
export async function applyMigration227(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".agent_schedules
        ADD COLUMN IF NOT EXISTS renews_schedule_id UUID;

      CREATE UNIQUE INDEX IF NOT EXISTS agent_schedules_renews_schedule_id_key
        ON "${schemaName}".agent_schedules (renews_schedule_id)
        WHERE renews_schedule_id IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (227, 'Plan 315 — agent_schedules.renews_schedule_id, one successor per schedule')
      ON CONFLICT (version) DO NOTHING;
  `);
}
