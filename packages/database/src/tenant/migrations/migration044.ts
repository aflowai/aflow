/**
 * Tenant migration 44 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration044(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DELETE FROM "${schemaName}".agent_schedules
        WHERE name IN ('cybernetic-scarcity-sweep', 'cybernetic-supervisory-sweep');
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (44, 'Plan 102h Phase 2 — purge stale cybernetic cron schedules')
      ON CONFLICT (version) DO NOTHING;
    `);
}
