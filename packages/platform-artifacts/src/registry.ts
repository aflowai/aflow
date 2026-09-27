import type { PlatformAgentEntry, PlatformSkillBundleEntry, PlatformWorkflowDef } from './types.js';
import {
  CAPABILITY_FLOWS,
  ML_PREDICTION_AGENT,
  CAPABILITY_SYSTEM_ROLES,
} from './capabilityAgents.js';
import { CYBERNETIC_AGENTS, CYBERNETIC_SYSTEM_ROLES } from './cyberneticAgents.js';
import { PLATFORM_SKILL_BUNDLES, ALL_PLATFORM_WORKFLOWS } from './skillBundles.js';
import { isPlatformAgentId } from './reservedKeys.js';

// ============================================================================
// Agent registry
// ============================================================================

/** Build the agent entries from the builder outputs + system role maps. */
function buildAgentEntries(): PlatformAgentEntry[] {
  const entries: PlatformAgentEntry[] = [];

  for (const flow of CAPABILITY_FLOWS) {
    const systemRole = CAPABILITY_SYSTEM_ROLES[flow.flowId];
    if (systemRole) {
      entries.push({
        agentId: flow.flowId,
        systemRole,
        definition: { ...flow, systemRole },
      });
    }
  }

  for (const flow of CYBERNETIC_AGENTS) {
    const systemRole = CYBERNETIC_SYSTEM_ROLES[flow.flowId];
    if (systemRole) {
      entries.push({
        agentId: flow.flowId,
        systemRole,
        definition: { ...flow, systemRole },
      });
    }
  }

  // ML Prediction Agent — not seeded into General, but still platform-owned
  if (isPlatformAgentId(ML_PREDICTION_AGENT.flowId)) {
    const systemRole = CAPABILITY_SYSTEM_ROLES[ML_PREDICTION_AGENT.flowId];
    if (systemRole) {
      entries.push({
        agentId: ML_PREDICTION_AGENT.flowId,
        systemRole,
        definition: { ...ML_PREDICTION_AGENT, systemRole },
      });
    }
  }

  return entries;
}

// Lazy-init indexes
let _agentEntries: PlatformAgentEntry[] | null = null;
let _agentById: Map<string, PlatformAgentEntry> | null = null;
let _agentByRole: Map<string, PlatformAgentEntry> | null = null;

function ensureAgentIndexes(): void {
  if (_agentEntries) return;
  _agentEntries = buildAgentEntries();
  _agentById = new Map(_agentEntries.map((e) => [e.agentId, e]));
  _agentByRole = new Map(_agentEntries.map((e) => [e.systemRole, e]));
}

// ============================================================================
// Skill bundle registry
// ============================================================================

let _bundleById: Map<string, PlatformSkillBundleEntry> | null = null;
let _workflowBySlug: Map<string, PlatformWorkflowDef> | null = null;
let _evalBySlug: Map<string, Record<string, unknown>> | null = null;

function ensureSkillIndexes(): void {
  if (_bundleById) return;
  _bundleById = new Map(PLATFORM_SKILL_BUNDLES.map((b) => [b.skillId, b]));
  _workflowBySlug = new Map(ALL_PLATFORM_WORKFLOWS.map((w) => [w.slug, w]));
  _evalBySlug = new Map(
    PLATFORM_SKILL_BUNDLES.filter((b) => b.evalSuite).map((b) => [b.skillId, b.evalSuite!]),
  );
}

// ============================================================================
// Agent lookup API
// ============================================================================

/** Get a platform agent by its agent ID (flowId). Returns null for non-platform agents. */
export function getPlatformAgent(agentId: string): PlatformAgentEntry | null {
  ensureAgentIndexes();
  return _agentById!.get(agentId) ?? null;
}

/** Get a platform agent by its system role. Returns null for non-platform roles. */
export function getPlatformAgentBySystemRole(role: string): PlatformAgentEntry | null {
  ensureAgentIndexes();
  return _agentByRole!.get(role) ?? null;
}

/** List all platform agents. */
export function listPlatformAgents(): readonly PlatformAgentEntry[] {
  ensureAgentIndexes();
  return _agentEntries!;
}

// ============================================================================
// Skill bundle lookup API
// ============================================================================

/** Get a platform skill bundle by skill ID. Returns null for non-platform skills. */
export function getPlatformSkillBundle(skillId: string): PlatformSkillBundleEntry | null {
  ensureSkillIndexes();
  return _bundleById!.get(skillId) ?? null;
}

/** List all platform skill bundles. */
export function listPlatformSkillBundles(): readonly PlatformSkillBundleEntry[] {
  return PLATFORM_SKILL_BUNDLES;
}

// ============================================================================
// Workflow lookup API
// ============================================================================

/** Get a platform workflow by slug. Covers both skill workflows and system stubs. */
export function getPlatformWorkflow(slug: string): PlatformWorkflowDef | null {
  ensureSkillIndexes();
  return _workflowBySlug!.get(slug) ?? null;
}

/** List all platform workflows (skill workflows + system stubs). */
export function listPlatformWorkflows(): readonly PlatformWorkflowDef[] {
  return ALL_PLATFORM_WORKFLOWS;
}

// ============================================================================
// Eval suite lookup API
// ============================================================================

/** Get a platform eval suite by workflow slug. Returns null if no eval suite exists. */
export function getPlatformEvalSuite(workflowSlug: string): Record<string, unknown> | null {
  ensureSkillIndexes();
  return _evalBySlug!.get(workflowSlug) ?? null;
}
