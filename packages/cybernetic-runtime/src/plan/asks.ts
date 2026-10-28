/**
 * The asked-once rule (Plan 331 D3.3): a wake that meets a `blocked` node
 * states what it waits on in the note's first line, and the space's Action
 * Center raises it, as a `decide` node's question is raised (Plan 322 D9). A
 * node asked about is not asked about again until its revision moves, so the
 * same question is never posted twice.
 *
 * The record is a Redis key per node holding the revision the node stands at
 * once asked — the revision the ask's own note write lands at, where it makes
 * one. Any later write moves the revision past it and re-arms the ask. The
 * Action Center item is read from the node and this record, and stored nowhere.
 */
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_ASK_HEAD,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_TREE_DEPTH_LIMIT,
  planNoteStatesWait,
  type PlanNode,
  type PlanNodeUpdate,
} from '@aflow/schemas';
import { publishActionCenterWake } from '@aflow/redis';
import { PLAN_TREE_WALK_BOUNDS, type PlanReadContext } from './operations.js';
import { orderPlanTree } from './tree.js';

/**
 * How long an ask stands without a write to its node. Past it the next wake
 * asks again — one reminder a week for a node nobody has answered — and the
 * record of a node deleted or closed meanwhile is gone with it.
 */
export const PLAN_ASKED_TTL_MS = 7 * 24 * 60 * 60_000;

/** The most asked nodes the space's Action Center lists at once. */
export const PLAN_OPEN_ASKS_LIMIT = 50;

/** The line an ask writes where the note does not already say what the node waits on. */
export const PLAN_ASK_DEFAULT_LINE = `${PLAN_NODE_ASK_HEAD}approve it on the plan page or in the Action Center to start it, or write what it needs.`;

export function askedKey(tenantId: string, spaceId: string, nodeId: string): string {
  return `plan:resident:asked:${tenantId}:${spaceId}:${nodeId}`;
}

export interface PlanAskContext extends PlanReadContext {
  redis: Redis;
  tenantId: string;
}

/** What a blocked node waits on, and the note write that says so where its note does not yet. */
export function planAsk(node: PlanNode): { waitsOn: string; update?: PlanNodeUpdate } {
  if (planNoteStatesWait(node.note)) {
    return { waitsOn: node.note?.split('\n', 1)[0] ?? PLAN_ASK_DEFAULT_LINE };
  }
  const note = (
    node.note !== undefined ? `${PLAN_ASK_DEFAULT_LINE}\n${node.note}` : PLAN_ASK_DEFAULT_LINE
  ).slice(0, PLAN_NODE_PROSE_MAX_CHARS);
  return {
    waitsOn: PLAN_ASK_DEFAULT_LINE,
    update: { nodeId: node.nodeId, expectedRevision: node.revision, note },
  };
}

/** The revision a node was last asked at, where it was; null where it was not or the record lapsed. */
export async function askedRevision(
  ctx: Pick<PlanAskContext, 'redis' | 'tenantId' | 'spaceId'>,
  nodeId: string,
): Promise<string | null> {
  return ctx.redis.get(askedKey(ctx.tenantId, ctx.spaceId, nodeId));
}

/** Whether the record names the revision the node stands at: asked, and not written since. */
export function isAsked(node: Pick<PlanNode, 'revision'>, record: string | null): boolean {
  return record !== null && Number(record) === node.revision;
}

// Writes the record only where it still holds what the caller read: two wakes
// that read the same node race here, and exactly one asks.
const CLAIM_ASK_LUA = `
local current = redis.call('GET', KEYS[1])
if (current == false and ARGV[1] == '') or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

/**
 * Record the ask, against the record as it was read. The revision recorded is
 * the one the node stands at once the ask's note write lands, so that write
 * does not read as a person's; a write that never lands leaves the node short
 * of it, and the next wake asks again.
 */
export async function claimAsk(
  ctx: Pick<PlanAskContext, 'redis' | 'tenantId' | 'spaceId'>,
  node: Pick<PlanNode, 'nodeId' | 'revision'>,
  read: string | null,
  writesNote: boolean,
): Promise<boolean> {
  const askedAt = node.revision + (writesNote ? 1 : 0);
  const taken = await ctx.redis.eval(
    CLAIM_ASK_LUA,
    1,
    askedKey(ctx.tenantId, ctx.spaceId, node.nodeId),
    read ?? '',
    String(askedAt),
    String(PLAN_ASKED_TTL_MS),
  );
  if (Number(taken) !== 1) return false;
  // An ask with no note write changes no node, so nothing else tells the Action Center.
  publishActionCenterWake(ctx.redis, {
    source: 'plan_ask',
    tenantId: ctx.tenantId,
    spaceId: ctx.spaceId,
  });
  return true;
}

function askable(node: PlanNode | null, record: string | null): node is PlanNode {
  return (
    node !== null && node.status === 'blocked' && node.kind !== 'decide' && isAsked(node, record)
  );
}

/**
 * The space's blocked nodes asked about at the revision they stand at, in tree
 * order, under open branches only — what its Action Center lists. A `decide`
 * node is asked by its own item.
 */
export async function listAskedNodes(ctx: PlanAskContext): Promise<PlanNode[]> {
  const walk = await ctx.store.walk(ctx.spaceId, {
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const blocked = orderPlanTree(walk.nodes)
    .map((placed) => placed.node)
    .filter((node) => node.status === 'blocked' && node.kind !== 'decide');
  if (blocked.length === 0) return [];
  const records = await ctx.redis.mget(
    ...blocked.map((node) => askedKey(ctx.tenantId, ctx.spaceId, node.nodeId)),
  );
  const asked = blocked
    .filter((node, i) => isAsked(node, records[i] ?? null))
    .slice(0, PLAN_OPEN_ASKS_LIMIT);
  const nodes = await Promise.all(asked.map((n) => ctx.store.find(ctx.spaceId, n.nodeId)));
  // Re-judged on the full read: a node written between the walk and here is not listed.
  return nodes.filter((node, i): node is PlanNode =>
    askable(node, records[blocked.indexOf(asked[i]!)] ?? null),
  );
}

/** One asked node by id, by the rule `listAskedNodes` lists by; null for any other. */
export async function findAskedNode(ctx: PlanAskContext, nodeId: string): Promise<PlanNode | null> {
  const node = await ctx.store.find(ctx.spaceId, nodeId);
  if (!askable(node, await askedRevision(ctx, nodeId))) return null;
  let parentId = node.parentId;
  for (let depth = 0; parentId !== null && depth < PLAN_TREE_DEPTH_LIMIT; depth++) {
    const parent = await ctx.store.find(ctx.spaceId, parentId);
    if (!parent || isClosedPlanNodeStatus(parent.status)) return null;
    parentId = parent.parentId;
  }
  return parentId === null ? node : null;
}
