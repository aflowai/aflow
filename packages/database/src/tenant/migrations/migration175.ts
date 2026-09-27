import type postgres from 'postgres';

/**
 * The coding lane is off in every space until an admin turns it on.
 *
 * `code.agent` is already granted to every Full Access profile (migration 120),
 * so capability alone would enable the lane everywhere the moment it is
 * deployed — in spaces whose admins never considered whether they wanted a
 * credential-bearing agent with network egress. The column is added without a
 * default so an absent policy reads as disabled, and existing spaces stay that
 * way until someone decides otherwise.
 */
export async function applyMigration175(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS code_policy JSONB;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (175, 'Plan 286 Phase 0 — per-space coding-lane opt-in (default off)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
