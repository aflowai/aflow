/**
 * Tenant migration 96 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration096(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"human.chat","accessMode":"read"},
          {"capabilityGroupId":"human.chat","accessMode":"write"},
          {"capabilityGroupId":"human.action_center","accessMode":"read"},
          {"capabilityGroupId":"human.action_center","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"human.chat","accessMode":"write"}]'::jsonb);
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"human.chat","accessMode":"read"},
          {"capabilityGroupId":"human.action_center","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"human.chat","accessMode":"read"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (96, 'Plan 156 §5.6 — human.chat + human.action_center capability groups in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
