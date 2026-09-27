/**
 * Tenant migration 37 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration037(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Rename goal.* → workflow.* and drop stale goal.manage entries
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = (
        SELECT jsonb_agg(elem)
        FROM (
          SELECT DISTINCT ON (elem->>'capabilityGroupId', elem->>'accessMode')
            CASE
              WHEN elem->>'capabilityGroupId' = 'goal.workflow'
              THEN jsonb_set(elem, '{capabilityGroupId}', '"workflow.manage"')
              WHEN elem->>'capabilityGroupId' = 'goal.run'
              THEN jsonb_set(elem, '{capabilityGroupId}', '"workflow.run"')
              WHEN elem->>'capabilityGroupId' = 'goal.ledger'
              THEN jsonb_set(elem, '{capabilityGroupId}', '"workflow.ledger"')
              ELSE elem
            END AS elem
          FROM jsonb_array_elements(allowed_capabilities) AS elem
          WHERE elem->>'capabilityGroupId' != 'goal.manage'
        ) sub
      )
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"goal.manage"}]'::jsonb
         OR allowed_capabilities @> '[{"capabilityGroupId":"goal.workflow"}]'::jsonb
         OR allowed_capabilities @> '[{"capabilityGroupId":"goal.run"}]'::jsonb
         OR allowed_capabilities @> '[{"capabilityGroupId":"goal.ledger"}]'::jsonb;
  
      -- Add workflow:read (for workflow.evaluate) to profiles that have workflow.manage:read
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"workflow","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"workflow","accessMode":"read"}]'::jsonb);
  
      -- Add workflow:write (for workflow.learn) to profiles that have workflow.manage:write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"workflow","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"workflow","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (37, 'Plan 99 — Rename goal.* capability groups to workflow.* for workflow operations')
      ON CONFLICT (version) DO NOTHING;
    `);
}
