/**
 * Tenant migration 61 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration061(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Add learner.observation:read to profiles that have workflow.manage:read
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"learner.observation","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"learner.observation","accessMode":"read"}]'::jsonb);
  
      -- Add learner.observation:write to profiles that have workflow.manage:write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"learner.observation","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"learner.observation","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (61, 'Plan 111 follow-up — Add learner.observation capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
