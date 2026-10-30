import { UNTITLED_CONVERSATION } from './conversation-title.js';

/**
 * Who proposed a change and from where, in the words a person reads on the
 * proposal card. Mirrors `ProposalProvenance` in `@aflow/schemas`, which the
 * client bundle does not import.
 */
export type ProposalSource =
  'coach' | 'compose_skill' | 'bind_capability' | 'operator' | 'agent_patch';

export interface ProposalProvenance {
  source: ProposalSource;
  conversation: { sessionId: string; title: string | null } | null;
}

const BYLINE: Record<ProposalSource, string> = {
  agent_patch: 'Patched by the Helmsman',
  compose_skill: 'Composed from a request',
  coach: 'Proposed by the Coach after a review',
  bind_capability: 'Set up from a request to connect a capability',
  operator: 'Proposed by the operator',
};

/** Shown on a proposal its author took back. Only the author can withdraw one. */
export const WITHDRAWN_BY_AUTHOR = 'Withdrawn by its author';

export function proposalByline(source: ProposalSource): string {
  return BYLINE[source];
}

/** The conversation's name as its list shows it. */
export function proposalConversationTitle(
  conversation: NonNullable<ProposalProvenance['conversation']>,
): string {
  const title = conversation.title?.trim();
  return title && title.length > 0 ? title : UNTITLED_CONVERSATION;
}

/** The chat route that opens a conversation, relative to its space. */
export function proposalConversationPath(
  conversation: NonNullable<ProposalProvenance['conversation']>,
): string {
  return `/chat?session=${encodeURIComponent(conversation.sessionId)}`;
}

export interface ProposalProvenanceView {
  byline: string;
  conversation: { title: string; path: string } | null;
  /** Present once the author has withdrawn the proposal. */
  withdrawn: string | null;
}

/** What the card says about where a proposal came from and what became of it. */
export function describeProposalProvenance(args: {
  provenance: ProposalProvenance | undefined;
  status: string | undefined;
  withdrawReason?: string | undefined;
}): ProposalProvenanceView | null {
  const withdrawn =
    args.status === 'withdrawn'
      ? args.withdrawReason?.trim()
        ? `${WITHDRAWN_BY_AUTHOR}: ${args.withdrawReason.trim()}`
        : WITHDRAWN_BY_AUTHOR
      : null;
  if (!args.provenance) {
    return withdrawn ? { byline: '', conversation: null, withdrawn } : null;
  }
  const conversation = args.provenance.conversation;
  return {
    byline: proposalByline(args.provenance.source),
    conversation: conversation
      ? {
          title: proposalConversationTitle(conversation),
          path: proposalConversationPath(conversation),
        }
      : null,
    withdrawn,
  };
}

/**
 * Items grouped under the source that asked, in first-seen order. A Coach
 * review and an agent's patch land in different groups.
 */
export function groupBySource<T>(
  items: readonly T[],
  heading: (item: T) => string,
): Array<{ heading: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = heading(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([key, grouped]) => ({ heading: key, items: grouped }));
}
