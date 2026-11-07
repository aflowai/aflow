import type { PlanNodeStatus } from '../../cybernetic/plan.js';
import type { PlanTreeNode } from './schemas.js';

/**
 * Whether a run in flight on `node` moves the work of `targetId`, the node at
 * or above it: the board's one definition of in-flight work, which the
 * waiting rule reads too. The target's own runs count whatever its status. A
 * run under it counts only on an `active` node: one on a blocked, waiting,
 * done or dropped node moves no work the target waits on, though that node's
 * own card reads in flight.
 */
export function planRunServes(
  targetId: string,
  node: { nodeId: string; status: PlanNodeStatus },
): boolean {
  return node.nodeId === targetId || node.status === 'active';
}

/**
 * The runs in flight that serve `targetId` (`planRunServes`) over its subtree,
 * the target included, each node's count read from `inFlightOf`.
 */
export function planRunsServing(
  targetId: string,
  subtree: Iterable<{ nodeId: string; status: PlanNodeStatus }>,
  inFlightOf: (nodeId: string) => number,
): number {
  let total = 0;
  for (const node of subtree) {
    if (planRunServes(targetId, node)) total += inFlightOf(node.nodeId);
  }
  return total;
}

/** `planRunsServing` over a tree node and every node under it, each carrying its own count. */
export function planTreeRunsServing(node: PlanTreeNode): number {
  const subtree: PlanTreeNode[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const next = stack.pop()!;
    subtree.push(next);
    stack.push(...next.children);
  }
  const counts = new Map(subtree.map((n) => [n.nodeId, n.counts.inFlightRuns]));
  return planRunsServing(node.nodeId, subtree, (id) => counts.get(id) ?? 0);
}
