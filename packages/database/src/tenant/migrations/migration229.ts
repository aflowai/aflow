import type postgres from 'postgres';

/**
 * Plan 324 phase 2 — a skill's `usage` block (whenToUse, whenNotToUse, next,
 * pitfalls) joins its discovery metadata, so skill search ranks by it and
 * returns it. The projection is rebuilt from every stored workflow, as the
 * memory-document trigger keeps it from then on.
 */
export async function applyMigration229(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".skill_discovery
      ADD COLUMN IF NOT EXISTS usage JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE OR REPLACE FUNCTION "${schema}".sync_skill_discovery(
      p_space UUID, p_path TEXT, p_content TEXT, p_deleted TIMESTAMPTZ
    ) RETURNS VOID LANGUAGE plpgsql AS $$
    DECLARE doc JSONB; skill_slug TEXT;
    BEGIN
      IF p_path !~ '^/workflows/[^/]+/workflow[.]json$' THEN RETURN; END IF;
      skill_slug := split_part(p_path, '/', 3);
      IF p_deleted IS NOT NULL OR p_content IS NULL THEN
        DELETE FROM "${schema}".skill_discovery WHERE space_id = p_space AND slug = skill_slug;
        RETURN;
      END IF;
      BEGIN doc := p_content::jsonb; EXCEPTION WHEN invalid_text_representation THEN doc := '{}'::jsonb; END;
      INSERT INTO "${schema}".skill_discovery (space_id, slug, name, description, usage, mode, status, revision)
      VALUES (p_space, skill_slug, COALESCE(doc->>'name', skill_slug), COALESCE(doc->>'description', ''),
        CASE WHEN jsonb_typeof(doc->'usage') = 'object' THEN doc->'usage' ELSE '{}'::jsonb END,
        CASE WHEN doc->>'mode' IN ('process','project','optimization') THEN doc->>'mode' ELSE 'process' END,
        COALESCE(doc->>'status', 'invalid'),
        CASE WHEN doc->>'revision' ~ '^[0-9]{1,9}$' THEN (doc->>'revision')::integer ELSE 0 END)
      ON CONFLICT (space_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        usage = EXCLUDED.usage, mode = EXCLUDED.mode, status = EXCLUDED.status, revision = EXCLUDED.revision;
    END $$;
    SELECT "${schema}".sync_skill_discovery(space_id, path, inline_content, deleted_at)
      FROM "${schema}".memory_docs WHERE path ~ '^/workflows/[^/]+/workflow[.]json$';

    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (229, 'Plan 324 — skill usage in the skill discovery metadata')
    ON CONFLICT (version) DO NOTHING;
  `);
}
