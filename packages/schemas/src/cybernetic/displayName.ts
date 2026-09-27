import type { AgentSystemRole } from '../artifact/flowDefinition.js';

/** Minimal agent shape this helper needs. Broader than `AgentDefinition` on purpose. */
export interface EntityDisplayAgentInput {
  systemRole?: AgentSystemRole | null | undefined;
  metadata: { name: string };
}

/** Minimal space shape this helper needs. */
export interface EntityDisplaySpaceInput {
  name: string;
  /** Presence of `directives` is the single marker of a cybernetic space (see 102d). */
  directives?: unknown;
}

/**
 * Resolve the user-facing display name for an agent in a given space.
 *
 * Rules:
 * 1. In a cybernetic space (directives !== null/undefined) AND the agent is
 *    the cybernetic Helmsman → `${space.name} Agent`.
 * 2. Otherwise → `agent.metadata.name` (stored display name).
 *
 * Runner and Coach are internal roles not intended for user-facing
 * labelling; callers that surface them (e.g. Console "System Agents" inspector)
 * should use `agent.metadata.name` directly.
 */
export function resolveEntityDisplayName(
  space: EntityDisplaySpaceInput,
  agent: EntityDisplayAgentInput,
): string {
  const isCybernetic = space.directives !== null && space.directives !== undefined;
  const isHelmsman = agent.systemRole === 'cybernetic-helmsman';
  if (isCybernetic && isHelmsman) {
    const base = space.name.trim();
    return base.length > 0 ? `${base} Agent` : 'Workspace Agent';
  }
  return agent.metadata.name;
}
