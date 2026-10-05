import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  OPEN_PLAN_NODE_STATUSES,
  type PlanNodeKind,
  type PlanNodeListTruncation,
  type PlanNodeStatus,
} from '@aflow/schemas';
import { listPlanNodeIdsDrivenBySession } from '../ledger/queries.js';
import { findPlanRootsOf, PLAN_TREE_WALK_BOUNDS } from './operations.js';
import { createPlanNodeStore, type PlanNodeStore } from './store.js';
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

// ============================================================================
// Work under the plan: runs and attention items by the node they serve
// ============================================================================

/** Where a run, or an attention item about one, sits in the plan. */
export interface PlanPlacement {
  nodeId: string;
  rootId: string;
}

/** The placement of each node named, by its id; a node not in the space has none. */
export async function placeInPlan(
  store: PlanNodeStore,
  spaceId: string,
  nodeIds: ReadonlyArray<string | undefined | null>,
): Promise<Map<string, PlanPlacement>> {
  const named = nodeIds.filter((id): id is string => typeof id === 'string');
  const roots = await findPlanRootsOf({ store, spaceId }, named);
  return new Map([...roots].map(([nodeId, rootId]) => [nodeId, { nodeId, rootId }]));
}

/**
 * The roots of the plan a conversation has taken up: those of every node a
 * run it drove serves. A conversation that has started nothing for the plan
 * has none, and every run and item placed in the plan is another's to it.
 */
export async function loadConversationPlanRoots(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  sessionId: string;
}): Promise<string[]> {
  const nodeIds = await listPlanNodeIdsDrivenBySession(
    params.db,
    params.tenantId,
    params.spaceId,
    params.sessionId,
  );
  if (nodeIds.length === 0) return [];
  const store = createPlanNodeStore(params.db, params.tenantId);
  const roots = await findPlanRootsOf({ store, spaceId: params.spaceId }, nodeIds);
  return [...new Set(roots.values())];
}

/** A line of work the attention block places: an active run or a pending attention item. */
export interface PlanWorkLine {
  kind: 'run' | 'item';
  /** The line as it reads, without indent or bullet. */
  line: string;
  plan?: PlanPlacement;
}

const PLAN_INDENT = '  ';

/** `[execute] 315 · Local first-run ergonomics — active — next: F114 … [nodeId: …]` (Plan 322 §3.3). */
function renderPlanNodeLine(node: PlanAttentionNode): string {
  const note = node.noteHead !== undefined ? ` — ${node.noteHead}` : '';
  return `${PLAN_INDENT.repeat(node.depth)}[${node.kind}] ${node.title} — ${node.status}${note} [nodeId: ${node.nodeId}]`;
}

/**
 * The plan section of the attention block: the open tree with this
 * conversation's work under the node it serves, its work on nodes the tree
 * does not show, and everything placed under another root as one count. That
 * count carries no ids and no call to act — another conversation's review or
 * pause is not this one's to answer. Work placed nowhere is the caller's.
 *
 * Every active run is in `work`; of the pending items, only the ones this
 * conversation is shown are — the rest arrive counted in `items`.
 */
export function renderPlanWithWork(
  plan: PlanAttention | undefined,
  work: readonly PlanWorkLine[],
  conversationRootIds: ReadonlySet<string>,
  items: { ownUnshown: number; others: number },
): string[] {
  const own = new Map<string, PlanWorkLine[]>();
  let otherRuns = 0;
  for (const entry of work) {
    if (entry.plan === undefined) continue;
    if (conversationRootIds.has(entry.plan.rootId)) {
      own.set(entry.plan.nodeId, [...(own.get(entry.plan.nodeId) ?? []), entry]);
    } else if (entry.kind === 'run') otherRuns++;
  }

  const lines: string[] = [];
  if (plan && plan.nodes.length > 0) {
    lines.push('Active plan — open a node with `plan.node.get`:');
    for (const node of plan.nodes) {
      lines.push(renderPlanNodeLine(node));
      for (const entry of own.get(node.nodeId) ?? []) {
        lines.push(`${PLAN_INDENT.repeat(node.depth + 1)}- ${entry.line}`);
      }
      own.delete(node.nodeId);
    }
    const more = plan.total - plan.nodes.length;
    if (more > 0) {
      const count = plan.truncated !== undefined ? `more than ${String(more)}` : String(more);
      lines.push(`   ... and ${count} more — use \`plan.node.list\``);
    }
  }
  if (own.size > 0) {
    lines.push("This conversation's work on plan nodes not listed above:");
    for (const [nodeId, entries] of own) {
      for (const entry of entries) lines.push(`- ${entry.line} [nodeId: ${nodeId}]`);
    }
  }
  if (items.ownUnshown > 0) {
    lines.push(
      `   ... and ${String(items.ownUnshown)} more of this conversation's attention items — use \`workflow.run.list_attention\``,
    );
  }
  if (otherRuns + items.others > 0) {
    lines.push(
      `other work in this space, not this conversation's: ${String(otherRuns)} runs, ${String(items.others)} items`,
    );
  }
  if (lines.length > 0) lines.push('');
  return lines;
}
