import { z } from 'zod';
import {
  resolveStagedChangeSource,
  StagedChangeSourceSchema,
  type StagedChange,
  type StagedChangeSource,
} from './stagedChange.js';

/**
 * Where a proposal came from, as every surface that lists one shows it. Each
 * field is derived from the proposal record, whatever its source or kind. The
 * conversation and the target's name are resolved at read time.
 */
export const ProposalProvenanceSchema = z.object({
  source: StagedChangeSourceSchema,
  /** The Source line, and the heading the proposal is listed under. */
  sourceLabel: z.string(),
  /** The conversation the proposing session belongs to, or null when none in the space holds it. */
  conversation: z
    .object({
      sessionId: z.string(),
      title: z.string().nullable(),
    })
    .nullable(),
  /** The proposing agent's role name, when the record names or implies one. */
  authorRole: z.string().nullable(),
  /** The session or run the record names as its author. */
  authorId: z.string().nullable(),
  /** The skill the proposal changes. `name` is null when the space no longer lists it. */
  target: z.object({ slug: z.string(), name: z.string().nullable() }).nullable(),
  /** The role name of the agent that withdrew it, once withdrawn. */
  withdrawnBy: z.string().nullable(),
});

export type ProposalProvenance = z.infer<typeof ProposalProvenanceSchema>;

const SYSTEM_ROLE_NAMES: Record<string, string> = {
  'cybernetic-helmsman': 'Helmsman',
  'cybernetic-coach': 'Coach',
  'cybernetic-runner': 'Runner',
  'mcp-runner': 'MCP runner',
};

/** An agent's role name as a reader is shown it: its platform role, else the name it was given. */
export function agentRoleName(agent: {
  systemRole?: string | null | undefined;
  metadata?: { name?: string | undefined } | undefined;
}): string {
  const byRole = agent.systemRole ? SYSTEM_ROLE_NAMES[agent.systemRole] : undefined;
  if (byRole) return byRole;
  const name = agent.metadata?.name?.trim();
  return name && name.length > 0 ? name.slice(0, 120) : 'Agent';
}

/** The role a source implies when the record names no agent. */
const ROLE_BY_SOURCE: Record<StagedChangeSource, string | null> = {
  coach: 'Coach',
  operator: 'Operator',
  agent_patch: null,
  compose_skill: null,
  bind_capability: null,
};

export function proposalAuthorRole(sc: StagedChange): string | null {
  return sc.proposedBy ?? ROLE_BY_SOURCE[resolveStagedChangeSource(sc)];
}

const SOURCE_LABELS: Record<Exclude<StagedChangeSource, 'agent_patch'>, string> = {
  coach: 'Coach review',
  compose_skill: 'Composed skill',
  bind_capability: 'Capability binding',
  operator: 'Operator amendment',
};

/** The Source line: a platform issue first, then an agent's patch by its role, then the source. */
export function proposalSourceLabel(sc: StagedChange): string {
  if (sc.resolutionRoute === 'platform_issue') return 'Platform issue';
  const source = resolveStagedChangeSource(sc);
  if (source === 'agent_patch') return `${sc.proposedBy ?? 'Agent'} patch`;
  return SOURCE_LABELS[source];
}

export function proposalWithdrawnBy(sc: StagedChange): string | null {
  return sc.status === 'withdrawn' ? (sc.withdrawnBy ?? null) : null;
}
