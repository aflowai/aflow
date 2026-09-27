/**
 * Tenant migration 13 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration013(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 13: Create "General" default space, migrate existing NULL space_ids.
  // Space is now mandatory for all entities — no tenant-wide (NULL) content.
  await sqlClient.unsafe(`
      -- Ensure a General space exists (idempotent via slug uniqueness)
      INSERT INTO "${schemaName}".spaces (name, slug, type, description)
      VALUES ('General', 'general', 'shared', 'Default shared space')
      ON CONFLICT (slug) DO NOTHING;
  
      -- Migrate all existing unscoped entities into the General space
      UPDATE "${schemaName}".agent_definitions
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      UPDATE "${schemaName}".sessions
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      UPDATE "${schemaName}".api_definitions
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      UPDATE "${schemaName}".memory_entries
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      UPDATE "${schemaName}".memory_docs
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      UPDATE "${schemaName}".memory_dirs
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (13, 'Mandatory spaces — General default + migrate NULL space_ids')
      ON CONFLICT (version) DO NOTHING;
    `);
}
