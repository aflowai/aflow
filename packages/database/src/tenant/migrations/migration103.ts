import type postgres from 'postgres';

export async function applyMigration103(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- ----------------------------------------------------------------------
      -- 1. Derive (credential_key, space_id) pairs from binding auth_json.
      -- A single binding's auth_json can carry up to five credential-key
      -- fields at once (basic auth = username + password), so we UNION five
      -- field-specific selects rather than COALESCE.
      -- ----------------------------------------------------------------------
      CREATE TEMP TABLE _m103_cred_space_refs (
        credential_key text NOT NULL,
        space_id uuid NOT NULL,
        PRIMARY KEY (credential_key, space_id)
      ) ON COMMIT DROP;

      INSERT INTO _m103_cred_space_refs (credential_key, space_id)
      SELECT credential_key, space_id FROM (
        SELECT auth_json->>'credentialKey'         AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'usernameCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'passwordCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'clientIdCredentialKey'     AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'clientSecretCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'credentialKey'         AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'usernameCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'passwordCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'clientIdCredentialKey'     AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'clientSecretCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
      ) refs
      WHERE credential_key IS NOT NULL
      ON CONFLICT DO NOTHING;

      -- ----------------------------------------------------------------------
      -- 2. Add api_credentials.space_id as nullable for the backfill window.
      -- ----------------------------------------------------------------------
      ALTER TABLE "${schemaName}".api_credentials
        ADD COLUMN IF NOT EXISTS space_id uuid;

      -- ----------------------------------------------------------------------
      -- 3. Duplicate each existing tenant-wide credential into every space
      --    that references it via a binding.
      -- ----------------------------------------------------------------------
      INSERT INTO "${schemaName}".api_credentials
        (credential_key, space_id, label, description, encrypted_value, created_at, updated_at)
      SELECT
        c.credential_key,
        r.space_id,
        c.label,
        c.description,
        c.encrypted_value,
        c.created_at,
        c.updated_at
      FROM "${schemaName}".api_credentials c
      JOIN _m103_cred_space_refs r ON r.credential_key = c.credential_key
      WHERE c.space_id IS NULL
      ON CONFLICT DO NOTHING;

      -- ----------------------------------------------------------------------
      -- 4. Delete the old tenant-wide rows.
      -- ----------------------------------------------------------------------
      DELETE FROM "${schemaName}".api_credentials WHERE space_id IS NULL;

      -- ----------------------------------------------------------------------
      -- 5. Delete any credential rows that ended up unreferenced. A row is
      --    unreferenced if no binding (API or MCP) in the same space points
      --    to it.
      -- ----------------------------------------------------------------------
      DELETE FROM "${schemaName}".api_credentials c
      WHERE NOT EXISTS (
        SELECT 1 FROM _m103_cred_space_refs r
        WHERE r.credential_key = c.credential_key AND r.space_id = c.space_id
      );

      -- ----------------------------------------------------------------------
      -- 6. Lock space_id NOT NULL and swap PK to (credential_key, space_id).
      -- ----------------------------------------------------------------------
      ALTER TABLE "${schemaName}".api_credentials
        ALTER COLUMN space_id SET NOT NULL;

      ALTER TABLE "${schemaName}".api_credentials
        DROP CONSTRAINT IF EXISTS api_credentials_pkey;

      ALTER TABLE "${schemaName}".api_credentials
        ADD PRIMARY KEY (credential_key, space_id);

      CREATE INDEX IF NOT EXISTS idx_api_credentials_space
        ON "${schemaName}".api_credentials (space_id);

      -- ----------------------------------------------------------------------
      -- 7. Delete the platform-seeded github + massive defs+bindings BEFORE
      --    we drop the source column (we use source = 'platform' as the
      --    selector). Anything they referenced and is now unreferenced is
      --    cleaned up in step 7b.
      -- ----------------------------------------------------------------------
      DELETE FROM "${schemaName}".api_bindings
        WHERE binding_id IN ('github-default', 'massive-default');

      DELETE FROM "${schemaName}".api_definitions
        WHERE source = 'platform';

      -- 7b. Refresh refs and clean up newly-unreferenced credential rows.
      DELETE FROM _m103_cred_space_refs;
      INSERT INTO _m103_cred_space_refs (credential_key, space_id)
      SELECT credential_key, space_id FROM (
        SELECT auth_json->>'credentialKey'         AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'usernameCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'passwordCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'clientIdCredentialKey'     AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'clientSecretCredentialKey' AS credential_key, space_id FROM "${schemaName}".api_bindings
        UNION ALL
        SELECT auth_json->>'credentialKey'         AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'usernameCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'passwordCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'clientIdCredentialKey'     AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
        UNION ALL
        SELECT auth_json->>'clientSecretCredentialKey' AS credential_key, space_id FROM "${schemaName}".mcp_server_bindings
      ) refs
      WHERE credential_key IS NOT NULL
      ON CONFLICT DO NOTHING;

      DELETE FROM "${schemaName}".api_credentials c
      WHERE NOT EXISTS (
        SELECT 1 FROM _m103_cred_space_refs r
        WHERE r.credential_key = c.credential_key AND r.space_id = c.space_id
      );

      -- ----------------------------------------------------------------------
      -- 8. Drop the source column + check constraint + index.
      -- ----------------------------------------------------------------------
      DROP INDEX IF EXISTS "${schemaName}".idx_api_definitions_source;
      ALTER TABLE "${schemaName}".api_definitions
        DROP CONSTRAINT IF EXISTS api_definitions_source_check;
      ALTER TABLE "${schemaName}".api_definitions
        DROP COLUMN IF EXISTS source;

      -- ----------------------------------------------------------------------
      -- 9. Cascade-delete rows in archived spaces (pre-existing backlog).
      -- spaceLifecycle.archiveSpace handles new archives going forward; this
      -- block mirrors that cascade for spaces already archived before
      -- migration 103 lands so no stale secrets / oauth state survive.
      -- ----------------------------------------------------------------------
      DELETE FROM "${schemaName}".api_definitions d
        USING "${schemaName}".spaces s
        WHERE d.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".api_bindings b
        USING "${schemaName}".spaces s
        WHERE b.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".api_credentials c
        USING "${schemaName}".spaces s
        WHERE c.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".mcp_oauth_tokens t
        USING "${schemaName}".spaces s
        WHERE t.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".mcp_oauth_state st
        USING "${schemaName}".spaces s
        WHERE st.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".mcp_server_bindings b
        USING "${schemaName}".spaces s
        WHERE b.space_id = s.id AND s.archived_at IS NOT NULL;
      DELETE FROM "${schemaName}".mcp_server_definitions d
        USING "${schemaName}".spaces s
        WHERE d.space_id = s.id AND s.archived_at IS NOT NULL;

      -- ----------------------------------------------------------------------
      -- 10. Final invariant: no NULL space_id credential rows survived.
      -- ----------------------------------------------------------------------
      DO $$
      DECLARE n int;
      BEGIN
        SELECT COUNT(*) INTO n FROM "${schemaName}".api_credentials WHERE space_id IS NULL;
        IF n > 0 THEN
          RAISE EXCEPTION 'Migration 103 failed: % api_credentials rows have NULL space_id', n;
        END IF;
      END $$;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (103, 'Plan 175 — space-scoped api_credentials; drop source; drop platform seed rows; cascade archived spaces')
      ON CONFLICT (version) DO NOTHING;
    `);
}
