import type postgres from 'postgres';

export async function applyMigration139(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id uuid NOT NULL,
        from_doc_id uuid NOT NULL REFERENCES "${schemaName}".memory_docs(id) ON DELETE CASCADE,
        target_path text NOT NULL,
        ordinal integer NOT NULL,
        occurrence_count integer NOT NULL DEFAULT 1,
        first_context text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (from_doc_id, target_path)
      );

      CREATE INDEX IF NOT EXISTS memory_links_target_idx
        ON "${schemaName}".memory_links (space_id, target_path);

      CREATE INDEX IF NOT EXISTS memory_links_from_idx
        ON "${schemaName}".memory_links (from_doc_id);

      ALTER TABLE "${schemaName}".memory_docs
        ADD COLUMN IF NOT EXISTS properties jsonb NOT NULL DEFAULT '{}'::jsonb;

      ALTER TABLE "${schemaName}".memory_docs
        ADD COLUMN IF NOT EXISTS derivation jsonb;

      CREATE INDEX IF NOT EXISTS memory_docs_properties_idx
        ON "${schemaName}".memory_docs USING gin (properties jsonb_path_ops);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (139, 'Plan 249 P1b — memory_links table + memory_docs properties/derivation columns (inert storage layer)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
