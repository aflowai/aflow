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
  PLAN_NODE_TITLE_MAX_CHARS,
  type PlanNode,
  type PlanNodeLink,
  type PlanNodeSummary,
} from '@aflow/schemas';
import type { NewPlanNode } from './store.js';

/** How many findings one carrier names; the rest are counted, and stay linked to the closed node. */
export const PLAN_CARRIER_FINDINGS_LIMIT = 50;

/** The carrier's first line: proposed, and which closed node it carries for. */
export function carrierHead(closed: Pick<PlanNode, 'nodeId' | 'title'>): string {
  return `${carrierPrefix(closed.nodeId)} ("${closed.title}"); approve it to have them fixed.`;
}

function carrierPrefix(nodeId: string): string {
  return `${PLAN_NODE_PROPOSED_HEAD}carries the findings left open when step ${nodeId} closed`;
}

/** Whether a node, by its note's first line, is a carrier for `nodeId`. */
export function isCarrierOf(node: Pick<PlanNodeSummary, 'noteHead'>, nodeId: string): boolean {
  return node.noteHead?.startsWith(carrierPrefix(nodeId)) === true;
}

/**
 * The findings a node closing now leaves to carry: those linked to it since its
 * newest carrier was proposed, so a node reopened and closed again does not
 * propose the findings it already handed on.
 */
export function findingsToCarry(
  findings: readonly PlanNodeLink[],
  siblings: readonly PlanNodeSummary[],
  closedId: string,
): PlanNodeLink[] {
  const carried = siblings
    .filter((node) => isCarrierOf(node, closedId))
    .map((node) => Date.parse(node.createdAt));
  const since = carried.length > 0 ? Math.max(...carried) : Number.NEGATIVE_INFINITY;
  return findings.filter((link) => Date.parse(link.createdAt) > since);
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
  return {
    parentId: closed.parentId,
    kind: 'execute',
    title:
      title.length <= PLAN_NODE_TITLE_MAX_CHARS
        ? title
        : `${title.slice(0, PLAN_NODE_TITLE_MAX_CHARS - 1)}…`,
    goal: `Fix the findings "${closed.title}" closed with still open, or settle with the operator that one is not to be fixed:\n${lines.join('\n')}`,
    criteria:
      'Each finding the goal lists is fixed by a merged change, or the operator has said it is not to be fixed.',
    note: carrierHead(closed),
    status: 'blocked',
  };
}
