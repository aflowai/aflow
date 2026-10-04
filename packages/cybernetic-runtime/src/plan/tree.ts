import type { PlanNodeSummary } from '@aflow/schemas';

export interface PlacedPlanNode {
  node: PlanNodeSummary;
  /** 0 for the node the walk starts from. */
  depth: number;
}

function bySiblingOrder(a: PlanNodeSummary, b: PlanNodeSummary): number {
  return a.position - b.position || a.nodeId.localeCompare(b.nodeId);
}

/**
 * Order nodes as the tree reads: each parent before its children, siblings by
 * position. Starts from the roots, or from `rootId` alone. A node whose parent
 * is not among `nodes` is unreachable and left out, which is what keeps an
 * open child of a closed parent out of a tree of open nodes.
 */
export function orderPlanTree(
  nodes: readonly PlanNodeSummary[],
  opts: { rootId?: string } = {},
): PlacedPlanNode[] {
  const childrenOf = new Map<string | null, PlanNodeSummary[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentId, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort(bySiblingOrder);

  const starts =
    opts.rootId !== undefined
      ? nodes.filter((n) => n.nodeId === opts.rootId)
      : (childrenOf.get(null) ?? []);

  const placed: PlacedPlanNode[] = [];
  const visited = new Set<string>();
  const stack: PlacedPlanNode[] = [...starts].reverse().map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    const next = stack.pop()!;
    // A moved node can close a loop between two sessions' writes; walk each node once.
    if (visited.has(next.node.nodeId)) continue;
    visited.add(next.node.nodeId);
    placed.push(next);
    const children = childrenOf.get(next.node.nodeId) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: next.depth + 1 });
    }
  }
  return placed;
}
