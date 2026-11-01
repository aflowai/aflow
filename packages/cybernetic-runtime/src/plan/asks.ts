/**
 * The asked-once rule (Plan 331 D3.3): a wake that meets a `blocked` node
 * states what it waits on below the existing note, and the space's Action
 * Center raises it, as a `decide` node's question is raised (Plan 322 D9). A
 * node asked about is not asked about again until its revision moves, so the
 * same question is never posted twice.
 *
 * The record is a Redis key per node holding the revision the node stands at
 * once asked — the revision the ask's own note write lands at, where it makes
 * one. Any later write moves the revision past it and re-arms the ask. The
 * record governs the walk's ask and the note line it writes, and nothing
 * else. The Action Center item is read from the node alone, at list time, and
 * stored nowhere (Plan 338 D1).
 */
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_ASK_HEAD,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_OPEN_ASKS_LIMIT,
  PLAN_TREE_DEPTH_LIMIT,
  planNoteHoldsMergeWait,
  planNoteWaitLine,
  planStepsAllClosed,
  type PlanNode,
  type PlanNodeSummary,
  type PlanNodeUpdate,
} from '@aflow/schemas';
import { publishActionCenterWake } from '@aflow/redis';
import { PLAN_TREE_WALK_BOUNDS, type PlanReadContext } from './operations.js';

/**
 * How long an ask stands without a write to its node. Past it the next wake
 * asks again — one reminder a week for a node nobody has answered — and the
 * record of a node deleted or closed meanwhile is gone with it.
 */
export const PLAN_ASKED_TTL_MS = 7 * 24 * 60 * 60_000;

/** The line an ask appends where the note does not already say what the node waits on. */
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
  const waitLine = planNoteWaitLine(node.note);
  if (waitLine !== undefined) return { waitsOn: waitLine };
  const existing = node.note ?? '';
  const room = PLAN_NODE_PROSE_MAX_CHARS - existing.length - (existing ? 1 : 0);
  if (room < PLAN_ASK_DEFAULT_LINE.length) return { waitsOn: PLAN_ASK_DEFAULT_LINE };
  const line = PLAN_ASK_DEFAULT_LINE;
  const note = existing ? `${existing}\n${line}` : line;
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

/**
 * Whether a node waits on a person, by the rule the Action Center lists by
 * (Plan 338 D1): open, not a `decide` node, and `blocked` or carrying the
 * merge-wait line. A `decide` node is raised by its own item. Whether every
 * branch above it is open is the walk's to say, which passes no closed node.
 * The store's summaries carry `mergeWait`, read from the whole note.
 */
export function isWaitingPlanNode(
  node: Pick<PlanNodeSummary, 'kind' | 'status' | 'mergeWait'>,
): boolean {
  if (node.kind === 'decide' || isClosedPlanNodeStatus(node.status)) return false;
  return (
    node.status === 'blocked' ||
    ((node.status === 'active' || node.status === 'waiting') && node.mergeWait === true)
  );
}

function waitingNode(node: PlanNode | null): node is PlanNode {
  return (
    node !== null &&
    isWaitingPlanNode({
      kind: node.kind,
      status: node.status,
      ...(planNoteHoldsMergeWait(node.note) ? { mergeWait: true as const } : {}),
    })
  );
}

/**
 * Whether a root's steps have all closed, so it asks for no approval whatever
 * its status (Plan 339 D6). A walk a bound cut short may have missed an open
 * step, so it answers no.
 */
export async function planRootStepsAllClosed(
  ctx: Pick<PlanReadContext, 'store' | 'spaceId'>,
  root: Pick<PlanNode, 'nodeId'>,
): Promise<boolean> {
  const walk = await ctx.store.walk(ctx.spaceId, {
    rootId: root.nodeId,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  if (walk.truncated !== undefined) return false;
  const steps = walk.nodes.filter((node) => node.nodeId !== root.nodeId);
  return planStepsAllClosed({
    steps: steps.length,
    done: steps.filter((step) => step.status === 'done').length,
    dropped: steps.filter((step) => step.status === 'dropped').length,
  });
}

/**
 * The open roots whose steps have all closed, from one overview read of the
 * space: the read the board's lanes place from, which counts each root's
 * closed steps. A root a bound cut short may hold an open step it did not
 * read, so it is never among them. One read answers for every root, so an
 * Action Center read walks the plan once however many roots it lists.
 */
async function finishedRoots(ctx: PlanReadContext): Promise<Set<string>> {
  const { placed } = await ctx.store.readOverview(ctx.spaceId, PLAN_TREE_WALK_BOUNDS, (read) => {
    const finished = new Set<string>();
    for (const root of read.nodes) {
      if (root.depth !== 0) continue;
      const counted = read.counted.get(root.nodeId);
      if (counted === undefined || counted.cut || counted.deeper) continue;
      const open = read.nodes.some((n) => n.depth > 0 && n.rootId === root.nodeId);
      const { done, dropped } = counted;
      if (!open && planStepsAllClosed({ steps: done + dropped, done, dropped })) {
        finished.add(root.nodeId);
      }
    }
    return { placed: finished, pullRequestsOf: [], runsOf: [], runsPerNode: 0 };
  });
  return placed;
}

/** The waiting nodes that still ask: all but a root whose steps have all closed. */
async function stillAsking(ctx: PlanReadContext, nodes: PlanNode[]): Promise<PlanNode[]> {
  if (!nodes.some((node) => node.parentId === null)) return nodes;
  const finished = await finishedRoots(ctx);
  return nodes.filter((node) => !finished.has(node.nodeId));
}

/** Newest first by `updatedAt`, a tie by id, so the cut keeps the same nodes on every read. */
function newestFirst(a: PlanNodeSummary, b: PlanNodeSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.nodeId.localeCompare(b.nodeId);
}

/**
 * The space's nodes that wait on a person, under open branches only — what its
 * Action Center lists. At most `PLAN_OPEN_ASKS_LIMIT`, newest first. The ask
 * record does not gate it: a node is listed the moment it is blocked, whether
 * or not a wake has asked about it, and after its record lapses. A root whose
 * steps have all closed is not listed, whatever its status (Plan 339 D6).
 */
export async function listWaitingNodes(ctx: PlanReadContext): Promise<PlanNode[]> {
  const walk = await ctx.store.walk(ctx.spaceId, {
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const listed = walk.nodes
    .filter(isWaitingPlanNode)
    .sort(newestFirst)
    .slice(0, PLAN_OPEN_ASKS_LIMIT);
  const nodes = await Promise.all(listed.map((n) => ctx.store.find(ctx.spaceId, n.nodeId)));
  // Re-judged on the full read: a node written between the walk and here is not listed.
  return stillAsking(ctx, nodes.filter(waitingNode));
}

/** One waiting node by id, by the rule `listWaitingNodes` lists by; null for any other. */
export async function findWaitingNode(
  ctx: PlanReadContext,
  nodeId: string,
): Promise<PlanNode | null> {
  const node = await ctx.store.find(ctx.spaceId, nodeId);
  if (!waitingNode(node)) return null;
  let parentId = node.parentId;
  for (let depth = 0; parentId !== null && depth < PLAN_TREE_DEPTH_LIMIT; depth++) {
    const parent = await ctx.store.find(ctx.spaceId, parentId);
    if (!parent || isClosedPlanNodeStatus(parent.status)) return null;
    parentId = parent.parentId;
  }
  if (parentId !== null) return null;
  return (await stillAsking(ctx, [node]))[0] ?? null;
}
