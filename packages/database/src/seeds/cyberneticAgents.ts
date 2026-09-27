import type postgres from 'postgres';
import {
  CYBERNETIC_AGENTS,
  CYBERNETIC_SYSTEM_ROLES,
  RUNNER_PROMPT_TEMPLATE,
} from '@aflow/platform-artifacts';

import { listTenantSchemas } from '../tenant.js';

/**
 * The seed writes the platform's cybernetic agents into a tenant schema. It
 * does not define them.
 *
 * It used to carry its own copy, kept in step by a parity test, and the copy
 * drifted the moment the Runner graph changed: the mirror still offered only
 * `submit_output` and `signal_blocked`, so a seeded Runner had no way to build
 * an output at all once submitting stopped taking one. A definition that must
 * be manually mirrored is a second system; this reads the one the runtime uses.
 */
export { CYBERNETIC_AGENTS, RUNNER_PROMPT_TEMPLATE };

// ============================================================================
// Exports
// ============================================================================

const FLOW_VERSION = '1';

// ============================================================================
// Seed function
// ============================================================================

export async function seedCyberneticAgents(sqlClient: postgres.Sql): Promise<{
  success: string[];
  skipped: string[];
  failed: Array<{ schema: string; error: unknown }>;
}> {
  const tenants = await listTenantSchemas(sqlClient);

  const results: {
    success: string[];
    skipped: string[];
    failed: Array<{ schema: string; error: unknown }>;
  } = {
    success: [],
    skipped: [],
    failed: [],
  };

  for (const tenant of tenants) {
    try {
      await seedCyberneticAgentsForTenant(sqlClient, tenant.schemaName);
      results.success.push(tenant.schemaName);
    } catch (err) {
      results.failed.push({ schema: tenant.schemaName, error: err });
    }
  }

  return results;
}

async function seedCyberneticAgentsForTenant(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const spaceRows = await sqlClient.unsafe(
    `SELECT id FROM "${schemaName}".spaces WHERE slug = 'general' LIMIT 1`,
  );

  const spaceRow = spaceRows[0] as { id: string } | undefined;
  if (!spaceRow) {
    throw new Error(`No "general" space found in schema ${schemaName}`);
  }

  const spaceId = spaceRow.id;

  await sqlClient.unsafe(`SET search_path TO "${schemaName}"`);
  try {
    const flowIds = CYBERNETIC_AGENTS.map((f) => f.flowId);

    await sqlClient`
      DELETE FROM agent_definitions
      WHERE agent_id = ANY(${flowIds})
        AND created_by != 'system'`;

    for (const flow of CYBERNETIC_AGENTS) {
      const systemRole = CYBERNETIC_SYSTEM_ROLES[flow.flowId];
      if (!systemRole) {
        throw new Error(`Missing systemRole mapping for cybernetic agent ${flow.flowId}`);
      }
      const flowWithRole = { ...flow, systemRole };
      const name = flow.metadata.name;

      const jsonStr = JSON.stringify(flowWithRole);
      await sqlClient.unsafe(
        `INSERT INTO agent_definitions (agent_id, version, name, definition_json, created_by, status, space_id)
         VALUES ($1, $2, $3, $4::jsonb, 'system', 'published', $5::uuid)
         ON CONFLICT (agent_id, version) DO UPDATE SET
           name = EXCLUDED.name,
           definition_json = EXCLUDED.definition_json,
           status = 'published',
           space_id = EXCLUDED.space_id`,
        [flow.flowId, FLOW_VERSION, name, jsonStr, spaceId],
      );
    }
  } finally {
    await sqlClient.unsafe(`SET search_path TO public`);
  }
}
