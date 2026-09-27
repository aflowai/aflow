/**
 * Tenant migration 47 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration047(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 47: Add user.input capability group to system profiles.
  // The cybernetic Worker needs user.input:read to handle human tasks
  // (pause for input, resume with user response).
  await sqlClient.unsafe(`
      -- Add user.input:read to profiles that have workflow.manage:read
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"user.input","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"user.input","accessMode":"read"}]'::jsonb);
  
      -- Add user.input:write to profiles that have workflow.manage:write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"user.input","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"user.input","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (47, 'Add user.input capability group for cybernetic Worker human tasks')
      ON CONFLICT (version) DO NOTHING;
    `);
}
