// ============================================================================
// Reserved agent IDs (= flowId)
// ============================================================================

export const PLATFORM_AGENT_IDS = new Set([
  // Capability agents
  'mcp-runner',
  'workflow-agent',
  // Cybernetic ensemble
  'cybernetic-helmsman',
  'cybernetic-runner',
  'cybernetic-coach',
]);

// ============================================================================
// Reserved system roles
// ============================================================================

export const PLATFORM_SYSTEM_ROLES = new Set([
  'mcp-runner',
  'cybernetic-helmsman',
  'cybernetic-runner',
  'cybernetic-coach',
]);

// ============================================================================
// Reserved skill IDs / workflow slugs
// ============================================================================

/**
 * Platform-owned skill IDs (= workflow slugs for platform skills).
 */
export const PLATFORM_SKILL_IDS = new Set(['compose-skill', 'bind-capability']);

/**
 * Platform-owned workflow slugs.
 * Includes both real skill workflows and system stubs.
 */
export const PLATFORM_WORKFLOW_SLUGS = new Set([
  // Real platform skill workflows
  'compose-skill',
  'bind-capability',
  // System workflow stubs
  'helmsman-supervisory-sweep',
  'coach-review-artifacts',
  'coach-consolidate-interaction',
  'coach-scarcity-sweep',
]);

// ============================================================================
// Provenance helpers — single entry point for write guards and UI
// ============================================================================

/** Check if an agent ID is owned by the platform. */
export function isPlatformAgentId(agentId: string): boolean {
  return PLATFORM_AGENT_IDS.has(agentId);
}

/** Check if a system role is owned by the platform. */
export function isPlatformSystemRole(role: string): boolean {
  return PLATFORM_SYSTEM_ROLES.has(role);
}

/** Check if a skill ID is owned by the platform. */
export function isPlatformSkillId(skillId: string): boolean {
  return PLATFORM_SKILL_IDS.has(skillId);
}

/** Check if a workflow slug is owned by the platform. */
export function isPlatformWorkflowSlug(slug: string): boolean {
  return PLATFORM_WORKFLOW_SLUGS.has(slug);
}

/**
 * Check if any artifact ID (agent, skill, or workflow) is platform-owned.
 * Convenience for write guards that don't know the artifact kind upfront.
 */
export function isPlatformArtifactId(id: string): boolean {
  return (
    PLATFORM_AGENT_IDS.has(id) || PLATFORM_SKILL_IDS.has(id) || PLATFORM_WORKFLOW_SLUGS.has(id)
  );
}
