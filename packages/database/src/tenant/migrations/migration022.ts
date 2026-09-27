/**
 * Tenant migration 22 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration022(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 22: Deduplicate system capability profiles and add unique constraint
  // Bug fix: Migration 20's INSERT lacked a conflict guard, so system profiles were
  // re-inserted on every migration run. This migration keeps the oldest copy of each
  // system profile (preserving any space_capability_assignments FK references) and
  // adds a unique partial index to prevent future duplicates.
  // NOTE: Split into separate unsafe() calls — postgres.js silently drops statements
  // after the first in a multi-statement unsafe() block.
  await sqlClient.unsafe(`
      DELETE FROM "${schemaName}".capability_profiles
      WHERE is_system_profile = true
        AND id NOT IN (
          SELECT DISTINCT ON (default_for_role) id
          FROM "${schemaName}".capability_profiles
          WHERE is_system_profile = true
          ORDER BY default_for_role, created_at ASC
        )
    `);
  await sqlClient.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_profiles_system_role
        ON "${schemaName}".capability_profiles (default_for_role)
        WHERE is_system_profile = true
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (22, 'Deduplicate system capability profiles and add unique constraint')
      ON CONFLICT (version) DO NOTHING
    `);
}
