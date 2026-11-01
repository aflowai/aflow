/**
 * Improvement enters as nodes (Plan 331 D6): a node that closes done with
 * findings linked to it — a review's findings its publication left open, the
 * gaps a commission reported — gets one node under the same parent to carry
 * them, the findings in its goal. A follow-up for findings a review carried is
 * approved work, so it starts as the first-status rule says (Plan 339 D6):
 * `active`, and the loop takes it in its turn. A resident wake never creates
 * active work (Plan 331 D5), so the carrier its done-close writes stays
 * `blocked`, proposed, until a person approves it.
 *
 * The carrier names the findings in prose, never as links of its own: a
 * carrier closing done means its findings were fixed, and links would have it
 * carry them again.
 */
import {
  planNodeFirstStatus,
  PLAN_NODE_PROPOSED_HEAD,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_TITLE_MAX_CHARS,
  type PlanNode,
  type PlanNodeLink,
} from '@aflow/schemas';
import type { NewPlanNode } from './store.js';

/** How many findings one carrier names; the rest are counted, and stay linked to the closed node. */
export const PLAN_CARRIER_FINDINGS_LIMIT = 50;

const CARRIER_HEAD = 'Carries the findings left open when step ';

/** The carrier's first line: which closed node it carries for. */
export function carrierHead(closed: Pick<PlanNode, 'nodeId' | 'title'>): string {
  return `${carrierToken(closed.nodeId)} ("${closed.title}").`;
}

/** Whether a note opens as a carrier's does, proposed by a resident wake or not. */
export function isFindingsCarrier(note: string | null | undefined): boolean {
  return (
    note?.startsWith(CARRIER_HEAD) === true ||
    note?.startsWith(`${PLAN_NODE_PROPOSED_HEAD}${CARRIER_HEAD}`) === true
  );
}

export function carrierToken(nodeId: string): string {
  return `${CARRIER_HEAD}${nodeId} closed`;
}

function findingLine(link: PlanNodeLink): string {
  return `- ${link.ref}${link.label !== undefined ? ` — ${link.label}` : ''}`;
}

/**
 * The carrier as it is written, under the closed node's parent: in its first
 * status, or `blocked` and proposed where a resident wake wrote the close.
 */
export function carrierNode(
  closed: Pick<PlanNode, 'nodeId' | 'title' | 'parentId'>,
  findings: readonly PlanNodeLink[],
  more: number,
  writer: { resident: boolean } = { resident: false },
): Omit<NewPlanNode, 'createdBy'> {
  const title = `Carry the open findings of "${closed.title}"`;
  const lines = findings.map(findingLine);
  if (more > 0) lines.push(`- and ${String(more)} more linked to step ${closed.nodeId}`);
  const goal = `Fix the findings "${closed.title}" closed with still open, or settle with the operator that one is not to be fixed:\n${lines.join('\n')}`;
  const overflow = `…\nSee the findings linked to step ${closed.nodeId} for the full text.`;
  return {
    parentId: closed.parentId,
    kind: 'execute',
    title:
      title.length <= PLAN_NODE_TITLE_MAX_CHARS
        ? title
        : `${title.slice(0, PLAN_NODE_TITLE_MAX_CHARS - 1)}…`,
    goal:
      goal.length <= PLAN_NODE_PROSE_MAX_CHARS
        ? goal
        : `${goal.slice(0, PLAN_NODE_PROSE_MAX_CHARS - overflow.length)}${overflow}`,
    criteria:
      'Each finding the goal lists is fixed by a merged change, or the operator has said it is not to be fixed.',
    ...(writer.resident
      ? { note: `${PLAN_NODE_PROPOSED_HEAD}${carrierHead(closed)}`, status: 'blocked' as const }
      : { note: carrierHead(closed), status: planNodeFirstStatus('findings_follow_up') }),
  };
}
