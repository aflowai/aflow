/**
 * Tenant migration 20 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration020(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".capability_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
  
        -- Capability allowlist/denylist (JSONB arrays of {capabilityGroupId, accessMode})
        allowed_capabilities JSONB NOT NULL DEFAULT '[]',
        denied_capabilities JSONB NOT NULL DEFAULT '[]',
        allowed_risk_modifiers JSONB NOT NULL DEFAULT '[]',
        denied_risk_modifiers JSONB NOT NULL DEFAULT '[]',
        allow_privileged BOOLEAN NOT NULL DEFAULT false,
  
        -- Role defaults
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_system_profile BOOLEAN NOT NULL DEFAULT false,
        default_for_role TEXT,
  
        -- Timestamps
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".space_capability_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL UNIQUE,
        profile_id UUID NOT NULL REFERENCES "${schemaName}".capability_profiles(id),
        assigned_by UUID,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_capability_profiles_default_role
        ON "${schemaName}".capability_profiles (default_for_role)
        WHERE is_default = true;
  
      -- Seed system profiles (match the prior hardcoded ADMIN/EDITOR/VIEWER_CAPABILITIES arrays)
      -- Only insert if no system profiles exist yet (idempotent guard)
      INSERT INTO "${schemaName}".capability_profiles
        (name, description, allowed_capabilities, denied_capabilities, allowed_risk_modifiers, denied_risk_modifiers, allow_privileged, is_default, is_system_profile, default_for_role)
      SELECT v.*
      FROM (VALUES
        (
          'Full Access'::text,
          'Full access to all capabilities including privileged operations. Default for space admins.'::text,
          '[{"capabilityGroupId":"ai.generate","accessMode":"read"},{"capabilityGroupId":"ai.agent","accessMode":"write"},{"capabilityGroupId":"ai.embedding","accessMode":"read"},{"capabilityGroupId":"ai.media","accessMode":"read"},{"capabilityGroupId":"memory.read","accessMode":"read"},{"capabilityGroupId":"memory.write","accessMode":"write"},{"capabilityGroupId":"search.read","accessMode":"read"},{"capabilityGroupId":"flow.control","accessMode":"write"},{"capabilityGroupId":"flow.manage","accessMode":"read"},{"capabilityGroupId":"flow.manage","accessMode":"write"},{"capabilityGroupId":"flow.schedule","accessMode":"read"},{"capabilityGroupId":"flow.schedule","accessMode":"write"},{"capabilityGroupId":"ui.generate","accessMode":"read"},{"capabilityGroupId":"ui.generate","accessMode":"write"},{"capabilityGroupId":"eval.manage","accessMode":"read"},{"capabilityGroupId":"eval.manage","accessMode":"write"},{"capabilityGroupId":"eval.read","accessMode":"read"},{"capabilityGroupId":"guardrail.manage","accessMode":"read"},{"capabilityGroupId":"guardrail.manage","accessMode":"write"},{"capabilityGroupId":"guardrail.read","accessMode":"read"},{"capabilityGroupId":"compute.run","accessMode":"write"},{"capabilityGroupId":"user.interaction","accessMode":"write"},{"capabilityGroupId":"user.notification","accessMode":"read"},{"capabilityGroupId":"user.notification","accessMode":"write"},{"capabilityGroupId":"integration.http.execute","accessMode":"write"},{"capabilityGroupId":"integration.definition.read","accessMode":"read"},{"capabilityGroupId":"integration.definition.write","accessMode":"write"},{"capabilityGroupId":"integration.binding.read","accessMode":"read"},{"capabilityGroupId":"integration.binding.write","accessMode":"write"},{"capabilityGroupId":"platform.space","accessMode":"read"},{"capabilityGroupId":"platform.space","accessMode":"write"},{"capabilityGroupId":"catalog.tool","accessMode":"read"},{"capabilityGroupId":"catalog.tool","accessMode":"write"},{"capabilityGroupId":"mcp.tool","accessMode":"read"},{"capabilityGroupId":"mcp.tool","accessMode":"write"},{"capabilityGroupId":"integration.registry","accessMode":"read"},{"capabilityGroupId":"design_system.read","accessMode":"read"},{"capabilityGroupId":"plan.read","accessMode":"read"},{"capabilityGroupId":"plan.write","accessMode":"write"}]'::jsonb,
          '[]'::jsonb,
          '["privileged","external_side_effect","admin"]'::jsonb,
          '[]'::jsonb,
          true, true, true, 'admin'::text
        ),
        (
          'Standard',
          'Broad access for editors. No privileged operations or flow management writes. Default for space editors.',
          '[{"capabilityGroupId":"ai.generate","accessMode":"read"},{"capabilityGroupId":"ai.agent","accessMode":"write"},{"capabilityGroupId":"ai.embedding","accessMode":"read"},{"capabilityGroupId":"ai.media","accessMode":"read"},{"capabilityGroupId":"memory.read","accessMode":"read"},{"capabilityGroupId":"memory.write","accessMode":"write"},{"capabilityGroupId":"search.read","accessMode":"read"},{"capabilityGroupId":"flow.control","accessMode":"write"},{"capabilityGroupId":"flow.manage","accessMode":"read"},{"capabilityGroupId":"flow.schedule","accessMode":"read"},{"capabilityGroupId":"flow.schedule","accessMode":"write"},{"capabilityGroupId":"ui.generate","accessMode":"read"},{"capabilityGroupId":"ui.generate","accessMode":"write"},{"capabilityGroupId":"eval.manage","accessMode":"read"},{"capabilityGroupId":"eval.manage","accessMode":"write"},{"capabilityGroupId":"eval.read","accessMode":"read"},{"capabilityGroupId":"guardrail.manage","accessMode":"read"},{"capabilityGroupId":"guardrail.manage","accessMode":"write"},{"capabilityGroupId":"guardrail.read","accessMode":"read"},{"capabilityGroupId":"compute.run","accessMode":"write"},{"capabilityGroupId":"user.interaction","accessMode":"write"},{"capabilityGroupId":"user.notification","accessMode":"read"},{"capabilityGroupId":"user.notification","accessMode":"write"},{"capabilityGroupId":"integration.http.execute","accessMode":"write"},{"capabilityGroupId":"integration.definition.read","accessMode":"read"},{"capabilityGroupId":"integration.binding.read","accessMode":"read"},{"capabilityGroupId":"catalog.tool","accessMode":"read"},{"capabilityGroupId":"catalog.tool","accessMode":"write"},{"capabilityGroupId":"mcp.tool","accessMode":"read"},{"capabilityGroupId":"mcp.tool","accessMode":"write"},{"capabilityGroupId":"integration.registry","accessMode":"read"},{"capabilityGroupId":"design_system.read","accessMode":"read"},{"capabilityGroupId":"plan.read","accessMode":"read"},{"capabilityGroupId":"plan.write","accessMode":"write"}]'::jsonb,
          '[]'::jsonb,
          '["external_side_effect"]'::jsonb,
          '[]'::jsonb,
          false, true, true, 'editor'
        ),
        (
          'Read Only',
          'Read-only access. No mutations except flow control for dispatching. Default for space viewers.',
          '[{"capabilityGroupId":"ai.generate","accessMode":"read"},{"capabilityGroupId":"ai.media","accessMode":"read"},{"capabilityGroupId":"memory.read","accessMode":"read"},{"capabilityGroupId":"search.read","accessMode":"read"},{"capabilityGroupId":"flow.control","accessMode":"write"},{"capabilityGroupId":"flow.manage","accessMode":"read"},{"capabilityGroupId":"eval.read","accessMode":"read"},{"capabilityGroupId":"guardrail.read","accessMode":"read"},{"capabilityGroupId":"catalog.tool","accessMode":"read"},{"capabilityGroupId":"integration.registry","accessMode":"read"},{"capabilityGroupId":"design_system.read","accessMode":"read"},{"capabilityGroupId":"plan.read","accessMode":"read"}]'::jsonb,
          '[]'::jsonb,
          '["external_side_effect"]'::jsonb,
          '[]'::jsonb,
          false, true, true, 'viewer'
        )
      ) AS v(name, description, allowed_capabilities, denied_capabilities, allowed_risk_modifiers, denied_risk_modifiers, allow_privileged, is_default, is_system_profile, default_for_role)
      WHERE NOT EXISTS (
        SELECT 1 FROM "${schemaName}".capability_profiles WHERE is_system_profile = true
      );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (20, 'Plan 28 Phase 2A — Capability profiles and space assignments')
      ON CONFLICT (version) DO NOTHING;
    `);
}
