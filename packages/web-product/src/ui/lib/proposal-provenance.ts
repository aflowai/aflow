import type { ProposalProvenance } from '@aflow/schemas';

export type { ProposalProvenance };

/** One labelled line of a proposal's provenance. `path` links the value, relative to its space. */
export interface ProposalProvenanceLine {
  label: string;
  text: string;
  path?: string;
}

/**
 * The Created by value: the conversation's title, linked. Without a title it
 * falls back to the agent's role name, then to the id the record names.
 */
export function proposalCreatedBy(provenance: ProposalProvenance): {
  text: string;
  path: string | null;
} {
  const conversation = provenance.conversation;
  const title = conversation?.title?.trim();
  const text =
    (title && title.length > 0 ? title : null) ??
    provenance.authorRole ??
    provenance.authorId ??
    conversation?.sessionId ??
    'Unknown';
  return {
    text,
    path: conversation ? `/chat?session=${encodeURIComponent(conversation.sessionId)}` : null,
  };
}

function line(label: string, text: string, path?: string | null): ProposalProvenanceLine {
  return path ? { label, text, path } : { label, text };
}

/**
 * The labelled lines a proposal card shows, in order, from the proposal
 * record alone. Every source and kind goes through this one path.
 */
export function describeProposalProvenance(args: {
  provenance: ProposalProvenance | undefined;
  rationale?: string | undefined;
  proposedAt?: string | undefined;
  status?: string | undefined;
  withdrawReason?: string | undefined;
  formatWhen?: (iso: string) => string;
}): ProposalProvenanceLine[] {
  const formatWhen = args.formatWhen ?? ((iso: string) => new Date(iso).toLocaleString());
  const { provenance } = args;
  const lines: ProposalProvenanceLine[] = [];
  if (provenance) {
    const createdBy = proposalCreatedBy(provenance);
    lines.push(line('Created by', createdBy.text, createdBy.path));
    lines.push(line('Source', provenance.sourceLabel));
  }
  const reason = args.rationale?.trim();
  if (reason) lines.push(line('Reason', reason));
  if (args.proposedAt) lines.push(line('When', formatWhen(args.proposedAt)));
  if (provenance?.target) {
    lines.push(line('Target', provenance.target.name ?? provenance.target.slug));
  }
  if (args.status === 'withdrawn') {
    if (provenance?.withdrawnBy) lines.push(line('Withdrawn by', provenance.withdrawnBy));
    const withdrawReason = args.withdrawReason?.trim();
    if (withdrawReason) lines.push(line('Withdrawal reason', withdrawReason));
  }
  return lines;
}

/** Items grouped under a heading, in first-seen order. */
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
