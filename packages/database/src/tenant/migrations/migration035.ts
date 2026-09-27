/**
 * Tenant migration 35 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration035(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Build a mapping CTE and apply it to both allowed and denied capabilities.
      -- Each old ID may expand to multiple new entries (e.g., ai.generate → ai.text + ai.json + ai.stream).
      -- Some old IDs map 1:1 (e.g., ai.agent stays ai.agent).
      -- For groups where read/write was split (memory.read/memory.write → memory.store),
      -- the accessMode is preserved from the original entry.
  
      WITH mapping(old_id, new_id) AS (VALUES
        ('ai.generate',                    'ai.text'),
        ('ai.agent',                       'ai.agent'),
        ('ai.embedding',                   'ai.embedding'),
        ('ai.media',                       'ai.media'),
        ('memory.read',                    'memory.store'),
        ('memory.write',                   'memory.store'),
        ('search.read',                    'search.web'),
        ('agent.control',                  'agent.control'),
        ('agent.manage',                   'agent.manage'),
        ('agent.schedule',                 'agent.schedule'),
        ('ui.generate',                    'ui.artifact'),
        ('eval.manage',                    'eval.suite'),
        ('eval.read',                      'eval.run'),
        ('guardrail.manage',              'guardrail.policy'),
        ('guardrail.read',               'guardrail.violation'),
        ('compute.run',                    'compute.sandbox'),
        ('user.interaction',              'user.interaction'),
        ('user.notification',             'user.notification'),
        ('integration.http.execute',      'api.http'),
        ('integration.definition.read',   'api.definition'),
        ('integration.definition.write',  'api.definition'),
        ('integration.binding.read',      'api.binding'),
        ('integration.binding.write',     'api.binding'),
        ('integration.webhook.read',      'webhook.endpoint'),
        ('integration.webhook.write',     'webhook.endpoint'),
        ('space.manage',                   'space.manage'),
        ('platform.space',                'space.manage'),
        ('platform.catalog',             'catalog.tool'),
        ('catalog.operation',             'catalog.tool'),
        ('mcp.tool',                       'mcp.tool'),
        ('goal.read',                      'goal.manage'),
        ('goal.write',                     'goal.manage'),
        ('goal.schedule',                  'goal.schedule'),
        ('design_system.read',            'ui.catalog'),
        ('plan.read',                      'goal.manage'),
        ('plan.write',                     'goal.manage')
      )
      UPDATE "${schemaName}".capability_profiles
      SET
        allowed_capabilities = COALESCE((
          SELECT jsonb_agg(DISTINCT new_entry)
          FROM jsonb_array_elements(allowed_capabilities) AS elem,
          LATERAL (
            SELECT COALESCE(m.new_id, elem->>'capabilityGroupId') AS gid
            FROM (SELECT 1) x
            LEFT JOIN mapping m ON m.old_id = elem->>'capabilityGroupId'
          ) mapped,
          LATERAL (
            SELECT jsonb_build_object(
              'capabilityGroupId', mapped.gid,
              'accessMode', elem->>'accessMode'
            ) AS new_entry
          ) built
        ), '[]'::jsonb),
        denied_capabilities = COALESCE((
          SELECT jsonb_agg(DISTINCT new_entry)
          FROM jsonb_array_elements(denied_capabilities) AS elem,
          LATERAL (
            SELECT COALESCE(m.new_id, elem->>'capabilityGroupId') AS gid
            FROM (SELECT 1) x
            LEFT JOIN mapping m ON m.old_id = elem->>'capabilityGroupId'
          ) mapped,
          LATERAL (
            SELECT jsonb_build_object(
              'capabilityGroupId', mapped.gid,
              'accessMode', elem->>'accessMode'
            ) AS new_entry
          ) built
        ), '[]'::jsonb);
  
      -- Also add new groups that ai.generate previously covered but are now separate
      -- (ai.json, ai.stream) to profiles that had ai.generate
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ai.json","accessMode":"read"},{"capabilityGroupId":"ai.stream","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"ai.text"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.json"}]'::jsonb);
  
      -- Add eval.analysis for profiles that had eval.run (was eval.read → split across run + analysis)
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"eval.analysis","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"eval.run"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"eval.analysis"}]'::jsonb);
  
      -- Add goal.workflow, goal.run, goal.ledger for profiles that had goal.manage:read
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"goal.workflow","accessMode":"read"},{"capabilityGroupId":"goal.run","accessMode":"read"},{"capabilityGroupId":"goal.ledger","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"goal.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"goal.workflow"}]'::jsonb);
  
      -- Add goal.workflow:write for profiles that had goal.manage:write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"goal.workflow","accessMode":"write"},{"capabilityGroupId":"goal.run","accessMode":"write"},{"capabilityGroupId":"goal.ledger","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"goal.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"goal.workflow","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (35, 'Plan 94 — Rewrite capability group IDs from hand-curated to derived stepType.group format')
      ON CONFLICT (version) DO NOTHING;
    `);
}
