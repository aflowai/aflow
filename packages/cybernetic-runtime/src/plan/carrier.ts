/**
 * Improvement enters as nodes (Plan 331 D6): a node that closes done with
 * findings linked to it — a review's findings its publication left open, the
 * gaps a commission reported — gets one node proposed under the same parent to
 * carry them, `blocked` until a person approves it, the findings in its goal.
 * The finding is then neither lost nor fixed without a person's say.
 *
 * The carrier names the findings in prose, never as links of its own: a
 * carrier closing done means its findings were fixed, and links would have it
 * carry them again.
 */
import {
  PLAN_NODE_PROPOSED_HEAD,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_TITLE_MAX_CHARS,
  type PlanNode,
  type PlanNodeLink,
} from '@aflow/schemas';
import type { NewPlanNode } from './store.js';

/** How many findings one carrier names; the rest are counted, and stay linked to the closed node. */
export const PLAN_CARRIER_FINDINGS_LIMIT = 50;

/** The carrier's first line: proposed, and which closed node it carries for. */
export function carrierHead(closed: Pick<PlanNode, 'nodeId' | 'title'>): string {
  return `${carrierToken(closed.nodeId)} ("${closed.title}"); approve it to have them fixed.`;
}

export function isFindingsCarrier(note: string | null | undefined): boolean {
  return (
    note?.startsWith(`${PLAN_NODE_PROPOSED_HEAD}carries the findings left open when step `) === true
  );
}

export function carrierToken(nodeId: string): string {
  return `${PLAN_NODE_PROPOSED_HEAD}carries the findings left open when step ${nodeId} closed`;
}

function findingLine(link: PlanNodeLink): string {
  return `- ${link.ref}${link.label !== undefined ? ` — ${link.label}` : ''}`;
}

/** The carrier as it is written: `blocked`, under the closed node's parent. */
export function carrierNode(
  closed: Pick<PlanNode, 'nodeId' | 'title' | 'parentId'>,
  findings: readonly PlanNodeLink[],
  more: number,
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
    note: carrierHead(closed),
    status: 'blocked',
  };
}
