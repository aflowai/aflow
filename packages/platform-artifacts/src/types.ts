import type { SkillGoal } from '@aflow/schemas';

// ============================================================================
// Agent entry
// ============================================================================

/**
 * A platform agent entry in the registry.
 *
 * The `definition` field holds the same shape stored in `agent_definitions.definition_json`.
 * It is loosely typed here because the builder functions produce objects that pass
 * `AgentDefinitionSchema.parse()` at runtime but use `Record<string, unknown>` for
 * step configs. Callers that need a strongly-typed `AgentDefinition` should parse
 * through the schema, exactly as the current DB path does.
 */
export interface PlatformAgentEntry {
  /** Stable agent ID (also the flowId). */
  agentId: string;
  /** System role for platform agents (e.g. 'orchestrator', 'cybernetic-helmsman'). */
  systemRole: string;
  /** The full agent definition, ready to be parsed via AgentDefinitionSchema. */
  definition: Record<string, unknown>;
}

// ============================================================================
// Skill bundle entry
// ============================================================================

export interface PlatformSkillBundleEntry {
  /** Stable skill ID (matches the workflow slug for platform skills). */
  skillId: string;
  /** The skill manifest. */
  manifest: PlatformSkillManifest;
  /** The workflow definition. */
  workflow: PlatformWorkflowDef;
  /** Optional eval suite. */
  evalSuite?: Record<string, unknown>;
}

/**
 * Manifest shape for a platform skill.
 * Matches SkillManifestSchema fields needed at seed time.
 */
export interface PlatformSkillManifest {
  schemaVersion: number;
  skillId: string;
  name: string;
  goal: SkillGoal;
  mode: string;
  origin: 'platform';
  workflowSlug: string;
  evalSuiteRef?: string;
  requiredCapabilities: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Workflow shape for a platform skill or system workflow stub.
 * Matches the structure written to `/workflows/{slug}/workflow.json`.
 */
export interface PlatformWorkflowDef {
  slug: string;
  name: string;
  description: string;
  goal?: string;
  mode: string;
  status: string;
  revision: number;
  origin: string;
  outcomes: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  stateVariables?: Array<Record<string, unknown>>;
  output?: Record<string, unknown>;
  iteration: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
