import {
  OPEN_PLAN_NODE_STATUSES,
  type PlanNodeKind,
  type PlanNodeListTruncation,
  type PlanNodeStatus,
} from '@aflow/schemas';
import { PLAN_TREE_WALK_BOUNDS } from './operations.js';
import type { PlanNodeStore } from './store.js';
import { orderPlanTree } from './tree.js';

/** Lines of plan the attention block carries; the rest is one `plan.node.list` away. */
export const PLAN_ATTENTION_NODE_LIMIT = 30;

export interface PlanAttentionNode {
  nodeId: string;
  kind: PlanNodeKind;
  title: string;
  status: PlanNodeStatus;
  noteHead?: string;
  /** 0 for a root. */
  depth: number;
}

export interface PlanAttention {
  /** Roots first, each followed by its open descendants, siblings by position. */
  nodes: PlanAttentionNode[];
  /** Every open node the walk read from the open roots, shown or not. */
  total: number;
  /** The bound that stopped the walk: open nodes past `total` exist, uncounted. */
  truncated?: PlanNodeListTruncation;
}

/**
 * The space's open plan tree as the Helmsman's attention block shows it: open
 * roots, and under each its open children. A node under a closed parent is
 * left out — closing a node closes the branch as far as the block is concerned.
 */
export async function loadActivePlanTree(
  store: PlanNodeStore,
  spaceId: string,
): Promise<PlanAttention | undefined> {
  const open = await store.walk(spaceId, {
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const tree = orderPlanTree(open.nodes);
  if (tree.length === 0) return undefined;
  return {
    nodes: tree.slice(0, PLAN_ATTENTION_NODE_LIMIT).map(({ node, depth }) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      status: node.status,
      ...(node.noteHead !== undefined ? { noteHead: node.noteHead } : {}),
      depth,
    })),
    total: tree.length,
    ...(open.truncated !== undefined ? { truncated: open.truncated } : {}),
  };
}
