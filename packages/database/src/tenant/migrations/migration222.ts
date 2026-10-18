import type postgres from 'postgres';

export async function applyMigration222(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schema}".skill_discovery (
      space_id UUID NOT NULL REFERENCES "${schema}".spaces(id) ON DELETE CASCADE,
      slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (space_id, slug)
    );
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
      INSERT INTO "${schema}".skill_discovery (space_id, slug, name, description, mode, status, revision)
      VALUES (p_space, skill_slug, COALESCE(doc->>'name', skill_slug), COALESCE(doc->>'description', ''),
        CASE WHEN doc->>'mode' IN ('process','project','optimization') THEN doc->>'mode' ELSE 'process' END,
        COALESCE(doc->>'status', 'invalid'),
        CASE WHEN doc->>'revision' ~ '^[0-9]{1,9}$' THEN (doc->>'revision')::integer ELSE 0 END)
      ON CONFLICT (space_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        mode = EXCLUDED.mode, status = EXCLUDED.status, revision = EXCLUDED.revision;
    END $$;
    CREATE OR REPLACE FUNCTION "${schema}".skill_discovery_on_doc() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        IF TG_OP = 'DELETE' OR OLD.path IS DISTINCT FROM NEW.path OR OLD.space_id IS DISTINCT FROM NEW.space_id THEN
          PERFORM "${schema}".sync_skill_discovery(OLD.space_id, OLD.path, NULL, now());
        END IF;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        PERFORM "${schema}".sync_skill_discovery(NEW.space_id, NEW.path, NEW.inline_content, NEW.deleted_at);
      END IF;
      RETURN NULL;
    END $$;
    DROP TRIGGER IF EXISTS skill_discovery_on_doc ON "${schema}".memory_docs;
    CREATE TRIGGER skill_discovery_on_doc AFTER INSERT OR UPDATE OR DELETE ON "${schema}".memory_docs
      FOR EACH ROW EXECUTE FUNCTION "${schema}".skill_discovery_on_doc();
    SELECT "${schema}".sync_skill_discovery(space_id, path, inline_content, deleted_at)
      FROM "${schema}".memory_docs WHERE path ~ '^/workflows/[^/]+/workflow[.]json$';

    UPDATE "${schema}".capability_profiles SET allowed_capabilities = allowed_capabilities ||
      '[{"capabilityGroupId":"catalog.skill","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"catalog.skill","accessMode":"read"}]'::jsonb);
  `);
  const splits: Record<string, string[]> = {
    run_skills: ['campaigns'],
    author_skills: ['inspect_skills', 'workflow_learning'],
    visuals: ['artifacts'],
    learning: ['proposals'],
    integrations: ['connection_inventory', 'http_bindings', 'webhooks'],
    mcp_servers: ['mcp_bindings', 'mcp_inventory'],
    media: ['images'],
    code: ['repositories', 'managed_code'],
  };
  for (const [original, children] of Object.entries(splits)) {
    for (const child of children) {
      await client.unsafe(
        `UPDATE "${schema}".spaces SET directives = jsonb_set(directives,
        ARRAY['capabilityDiscovery','bundlePlacements',$1::text], directives #> ARRAY['capabilityDiscovery','bundlePlacements',$2::text], true)
        WHERE directives #> ARRAY['capabilityDiscovery','bundlePlacements',$2::text] IS NOT NULL
          AND directives #> ARRAY['capabilityDiscovery','bundlePlacements',$1::text] IS NULL`,
        [child, original],
      );
    }
  }
  await client.unsafe(`INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (222, 'Plan 324 — skill discovery metadata, capability grants and split placement choices') ON CONFLICT (version) DO NOTHING`);
}
