/**
 * Tenant migration 33 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration033(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 33: Per-space path uniqueness for memory_docs and memory_dirs.
  // Previously path was globally unique per tenant — two spaces could not have
  // the same path. Now path is unique per (path, space_id), giving each space
  // its own isolated filesystem namespace.
  await sqlClient.unsafe(`
      -- Backfill any NULL space_ids on memory_docs
      UPDATE "${schemaName}".memory_docs
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      -- Backfill any NULL space_ids on memory_dirs
      UPDATE "${schemaName}".memory_dirs
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      -- Make space_id NOT NULL on both tables
      ALTER TABLE "${schemaName}".memory_docs
        ALTER COLUMN space_id SET NOT NULL;
      ALTER TABLE "${schemaName}".memory_dirs
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Drop old global unique constraint on path (Drizzle names it _key, manual SQL names it _unique)
      ALTER TABLE "${schemaName}".memory_docs
        DROP CONSTRAINT IF EXISTS memory_docs_path_key;
      ALTER TABLE "${schemaName}".memory_docs
        DROP CONSTRAINT IF EXISTS memory_docs_path_unique;
      ALTER TABLE "${schemaName}".memory_docs
        DROP CONSTRAINT IF EXISTS memory_docs_path_space_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_docs_path_space
        ON "${schemaName}".memory_docs(path, space_id);
  
      ALTER TABLE "${schemaName}".memory_dirs
        DROP CONSTRAINT IF EXISTS memory_dirs_path_key;
      ALTER TABLE "${schemaName}".memory_dirs
        DROP CONSTRAINT IF EXISTS memory_dirs_path_unique;
      ALTER TABLE "${schemaName}".memory_dirs
        DROP CONSTRAINT IF EXISTS memory_dirs_path_space_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_dirs_path_space
        ON "${schemaName}".memory_dirs(path, space_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (33, 'Per-space path uniqueness — memory_docs and memory_dirs isolated per space')
      ON CONFLICT (version) DO NOTHING;
    `);
}
