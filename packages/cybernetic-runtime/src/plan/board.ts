/**
 * The plan as the operator's board reads it (Plan 322 P3.3): each node with
 * what its card shows — counts in place of its links, the goal's head in place
 * of its prose — and each plan's tallies, counted before a done window leaves
 * anything out; and the overview's rows and lanes across every plan (Plan 332
 * D7). Pure: the store's reads come in, the response goes out.
 */
import {
  isClosedPlanNodeStatus,
  PLAN_LANE_ITEMS_LIMIT,
  PlanNodeLinkKindSchema,
  planBoardCards,
  planBoardColumn,
  type PlanBoardPlacement,
  type PlanLane,
  type PlanLaneItem,
  type PlanOverviewOutput,
  type PlanDoneDay,
  type PlanNodeListTruncation,
  type PlanNodePullRequest,
  type PlanNodeStatus,
  type PlanNodeSummary,
  type PlanRootCounts,
  type PlanRootRow,
  type PlanRootState,
  type PlanRootTally,
  type PlanTreeNode,
} from '@aflow/schemas';
import {
  bySiblingOrder,
  nestPlanTree,
  type PlacedPlanNode,
  type PlanTreeWalkBounds,
} from './tree.js';
import { findActiveStreamNode, mergeShaOf } from './stream.js';
import {
  planBoardNoteHead,
  type PlanLinkPageKey,
  type PlanNodeBoardFacts,
  type PlanNodeLinkTally,
  type PlanNodeNewestPullRequest,
} from './store.js';
import type { PlanOverviewNode, PlanOverviewRead } from './overviewReads.js';

/** What the store read for the walked nodes, each map keyed by node id. */
export interface PlanBoardReads {
  facts: ReadonlyMap<string, PlanNodeBoardFacts>;
  tallies: ReadonlyMap<string, PlanNodeLinkTally>;
  pullRequests: ReadonlyMap<string, PlanNodeNewestPullRequest>;
  inFlight: ReadonlyMap<string, number>;
}

export interface PlanBoardOptions {
  /** Done nodes closed before this instant leave the tree, unless a node kept sits under one. */
  closedSince?: string;
  /** The IANA time zone `doneByDay` counts days in; UTC when absent. */
  tz?: string;
}

const NO_TALLY: PlanNodeLinkTally = {
  runs: 0,
  pullRequests: 0,
  findings: 0,
  documents: 0,
  rounds: 0,
};

/**
 * Reads the calendar day an instant falls on in `tz`, as `YYYY-MM-DD`. One
 * formatter serves every instant it is asked about: building one is the
 * costly part, and a board reads a day for every done node.
 */
export function planDayReader(tz = 'UTC'): (iso: string) => string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (iso) => {
    const parts = format.formatToParts(new Date(iso));
    const part = (type: 'year' | 'month' | 'day') =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}

/** A node's newest pull request as a card or a lane row shows it. */
export function cardPullRequest(pullRequest: PlanNodeNewestPullRequest): PlanNodePullRequest {
  const mergeSha = mergeShaOf(pullRequest.merge?.label);
  return {
    url: pullRequest.ref,
    merged: pullRequest.merge !== null,
    ...(mergeSha !== undefined ? { mergeSha } : {}),
  };
}

function boardNode(node: PlanNodeSummary, reads: PlanBoardReads): PlanTreeNode {
  const facts = reads.facts.get(node.nodeId);
  const { rounds, ...links } = reads.tallies.get(node.nodeId) ?? NO_TALLY;
  const inFlightRuns = reads.inFlight.get(node.nodeId) ?? 0;
  const pullRequest = reads.pullRequests.get(node.nodeId);
  // The node's own row, read after the walk, is the newer word on both times:
  // a node reopened between the reads has no `closedAt`, whatever the summary
  // carried. A node the walk read and its row did not was deleted between
  // them, and only its summary's times are left.
  const { closedAt: summaryClosedAt, noteHead: summaryNoteHead, ...summary } = node;
  const closedAt = facts !== undefined ? facts.closedAt : summaryClosedAt;
  const noteHead = facts !== undefined ? facts.noteHead : planBoardNoteHead(summaryNoteHead);
  return {
    ...summary,
    createdAt: facts?.createdAt ?? node.createdAt,
    ...(closedAt !== undefined ? { closedAt } : {}),
    goalHead: facts?.goalHead ?? '',
    ...(noteHead !== undefined ? { noteHead } : {}),
    counts: { ...links, inFlightRuns },
    rounds,
    activity: inFlightRuns > 0 ? 'in_flight' : 'idle',
    ...(pullRequest !== undefined ? { pullRequest: cardPullRequest(pullRequest) } : {}),
    children: [],
  };
}

/** A run in flight serves an active node at or under `node`. */
function servesActiveBelow(node: PlanTreeNode): boolean {
  if (node.status === 'active' && node.counts.inFlightRuns > 0) return true;
  return node.children.some(servesActiveBelow);
}

/**
 * A parent's progress and activity are its children's: progress, those done
 * of those not dropped; activity, in flight where a run serves the parent or
 * any active node under it — runs serve the steps under a root or phase,
 * rarely the parent itself. A run still serving a done or dropped child moves
 * no work the parent waits on, so it leaves the parent idle, though that
 * child's own card reads in flight.
 */
function withChildren(node: PlanTreeNode): PlanTreeNode {
  const children = node.children.map(withChildren);
  if (children.length === 0) return { ...node, children };
  const counted = children.filter((child) => child.status !== 'dropped');
  return {
    ...node,
    children,
    activity:
      node.counts.inFlightRuns > 0 || children.some(servesActiveBelow) ? 'in_flight' : 'idle',
    progress: {
      done: counted.filter((child) => child.status === 'done').length,
      total: counted.length,
    },
  };
}

/**
 * The step under `root` the stream walk takes next, read over the same tree
 * the board places: the walk passes over closed nodes itself, so the whole
 * tree is its input. The root is no step, so a walk that stops there names none.
 */
function nextNodeIdOf(root: PlanTreeNode): string | undefined {
  const nodes: PlanTreeNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    stack.push(...node.children);
  }
  const next = findActiveStreamNode(nodes, root.nodeId);
  return next !== null && next.nodeId !== root.nodeId ? next.nodeId : undefined;
}

/**
 * A plan's state (Plan 332 D3) from its root's status and its steps counted by
 * column, the first that holds deciding. A plan that needs the operator and
 * has work in flight reads `needs_you`; its row carries both counts. Every
 * step closed is `finished`, never a status: the root stays open until the
 * operator closes it, because a node is done against its own criteria, not
 * its children's (Plan 322 D2).
 */
export function planRootState(
  rootStatus: PlanNodeStatus,
  counts: Pick<PlanRootCounts, 'steps' | 'needsYou' | 'inFlight' | 'upNext'>,
): PlanRootState {
  if (isClosedPlanNodeStatus(rootStatus)) return 'closed';
  if (counts.needsYou > 0) return 'needs_you';
  if (counts.inFlight > 0) return 'in_flight';
  if (counts.upNext > 0) return 'queued';
  return counts.steps > 0 ? 'finished' : 'empty';
}

function tallyOf(root: PlanTreeNode, dayOf: (iso: string) => string): PlanRootTally {
  const counts = { needs_you: 0, in_flight: 0, up_next: 0, done: 0, dropped: 0 };
  const byDay = new Map<string, number>();
  const cards = planBoardCards(root);
  for (const { node, column } of cards) {
    counts[column]++;
    if (column === 'done' && node.closedAt !== undefined) {
      const day = dayOf(node.closedAt);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
  }
  const nextNodeId = nextNodeIdOf(root);
  const counted: PlanRootCounts = {
    steps: cards.length,
    needsYou: counts.needs_you,
    inFlight: counts.in_flight,
    upNext: counts.up_next,
    done: counts.done,
    dropped: counts.dropped,
  };
  return {
    rootId: root.nodeId,
    state: planRootState(root.status, counted),
    ...counted,
    doneByDay: [...byDay]
      .map(([day, count]): PlanDoneDay => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    ...(nextNodeId !== undefined ? { nextNodeId } : {}),
  };
}

/** A done node closed before `since` leaves, unless a node kept sits under it. */
function prune(nodes: readonly PlanTreeNode[], since: number): PlanTreeNode[] {
  const kept: PlanTreeNode[] = [];
  for (const node of nodes) {
    const children = prune(node.children, since);
    const closedBefore =
      node.status === 'done' && node.closedAt !== undefined && Date.parse(node.closedAt) < since;
    if (!closedBefore || children.length > 0) kept.push({ ...node, children });
  }
  return kept;
}

/** Boards built from placed nodes: every tree in reading order, and each root's tally in the same order. */
export interface PlanBoards {
  roots: PlanTreeNode[];
  tallies: PlanRootTally[];
}

/**
 * The board from nodes placed in reading order: nested, each with its card's
 * facts and a parent with its progress and activity; each root's tallies over
 * every node under it; then the done window applied below the roots, which
 * always stay.
 */
export function buildPlanBoard(
  placed: readonly PlacedPlanNode[],
  reads: PlanBoardReads,
  opts: PlanBoardOptions = {},
): PlanBoards {
  const full = nestPlanTree(placed, (node) => boardNode(node, reads)).map(withChildren);
  const dayOf = planDayReader(opts.tz);
  const tallies = full.map((root) => tallyOf(root, dayOf));
  const since = opts.closedSince !== undefined ? Date.parse(opts.closedSince) : undefined;
  const roots =
    since === undefined
      ? full
      : full.map((root) => ({ ...root, children: prune(root.children, since) }));
  return { roots, tallies };
}

/** A closed root as the plan list shows it: `closed` by rule, from the root's own row, its steps unread. */
export function closedPlanRow(root: PlanNodeSummary): PlanRootRow {
  return {
    nodeId: root.nodeId,
    title: root.title,
    status: root.status,
    position: root.position,
    revision: root.revision,
    state: 'closed',
    lastWrittenAt: root.updatedAt,
  };
}

// ============================================================================
// The overview: every plan as a row, and the lanes across them (Plan 332 D7)
// ============================================================================

/**
 * The open steps a run serves through an active step under them: every open
 * node above an `active` step with a run in flight, whatever closed nodes lie
 * between — the activity `withChildren` gives a parent, read without the
 * closed nodes the overview does not ship.
 */
function servedFromBelow(steps: readonly PlanOverviewNode[]): Set<string> {
  const byId = new Map(steps.map((step) => [step.nodeId, step]));
  const served = new Set<string>();
  for (const step of steps) {
    if (step.status !== 'active' || step.inFlightRuns === 0) continue;
    let above = step.openParentId !== null ? byId.get(step.openParentId) : undefined;
    while (above !== undefined && !served.has(above.nodeId)) {
      served.add(above.nodeId);
      above = above.openParentId !== null ? byId.get(above.openParentId) : undefined;
    }
  }
  return served;
}

function laneItem(
  step: PlanOverviewNode,
  root: PlanOverviewNode,
  placement: PlanBoardPlacement,
): PlanLaneItem {
  return {
    nodeId: step.nodeId,
    title: step.title,
    kind: step.kind,
    status: step.status,
    revision: step.revision,
    ...(step.noteHead !== undefined ? { noteHead: step.noteHead } : {}),
    updatedAt: step.updatedAt,
    rootId: root.nodeId,
    rootTitle: root.title,
    ...(step.phaseTitle !== undefined ? { phaseTitle: step.phaseTitle } : {}),
    ...(placement.column === 'needs_you' ? { reason: placement.reason } : {}),
    ...(placement.reason === 'stranded' && step.closedAncestor !== undefined
      ? { closedAncestor: step.closedAncestor }
      : {}),
    ...(placement.column === 'in_flight' ? { runs: [], runsTotal: step.inFlightRuns } : {}),
  };
}

function later(a: string, b: string | undefined): string {
  return b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;
}

function lane(items: readonly PlanLaneItem[], limit: number): PlanLane {
  return { items: items.slice(0, limit), total: items.length };
}

/**
 * The overview from its store read (Plan 332 D7): every root returned as a
 * row and the three lanes, each open step placed by the board's own column
 * rule (`planBoardColumn`) with its activity derived as the board derives it.
 * A row counts the open steps the read returned and every closed one; a plan
 * the node bound left open steps of, or with steps past the depth bound,
 * carries that bound as its own `truncated` and is never `finished`. Up next
 * holds, per open plan, the step `findActiveStreamNode` takes over the same
 * nodes, where that step stands under Up next. Pull requests and runs are not
 * read here: the lanes' rows carry none.
 */
export function buildPlanOverview(
  read: PlanOverviewRead,
  bounds: PlanTreeWalkBounds,
  laneLimit = PLAN_LANE_ITEMS_LIMIT,
): PlanOverviewOutput {
  const roots = read.nodes.filter((node) => node.depth === 0).sort(bySiblingOrder);
  const stepsOf = new Map<string, PlanOverviewNode[]>();
  for (const node of read.nodes) {
    if (node.depth === 0) continue;
    const steps = stepsOf.get(node.rootId) ?? [];
    steps.push(node);
    stepsOf.set(node.rootId, steps);
  }
  const needsYou: PlanLaneItem[] = [];
  const inFlight: PlanLaneItem[] = [];
  const upNext: PlanLaneItem[] = [];

  const rows = roots.map((root): PlanRootRow => {
    if (isClosedPlanNodeStatus(root.status)) return closedPlanRow(root);
    const steps = (stepsOf.get(root.nodeId) ?? []).sort((a, b) => a.walkOrder - b.walkOrder);
    const counted = read.counted.get(root.nodeId);
    const served = servedFromBelow(steps);
    const columns = { needs_you: 0, in_flight: 0, up_next: 0 };
    const placements = new Map<string, PlanBoardPlacement>();
    let lastWrittenAt = later(root.updatedAt, counted?.closedWrittenAt);
    for (const step of steps) {
      const activity = step.inFlightRuns > 0 || served.has(step.nodeId) ? 'in_flight' : 'idle';
      const placement = planBoardColumn(
        { kind: step.kind, status: step.status, activity },
        { closedAncestor: step.closedAncestor !== undefined },
      );
      placements.set(step.nodeId, placement);
      lastWrittenAt = later(lastWrittenAt, step.updatedAt);
      if (placement.column === 'needs_you') {
        columns.needs_you++;
        needsYou.push(laneItem(step, root, placement));
      } else if (placement.column === 'in_flight') {
        columns.in_flight++;
        inFlight.push(laneItem(step, root, placement));
      } else if (placement.column === 'up_next') {
        columns.up_next++;
      }
    }
    const next = findActiveStreamNode([root, ...steps], root.nodeId);
    const nextStep = steps.find((step) => step.nodeId === next?.nodeId);
    const nextPlacement = nextStep !== undefined ? placements.get(nextStep.nodeId) : undefined;
    if (nextStep !== undefined && nextPlacement?.column === 'up_next') {
      upNext.push(laneItem(nextStep, root, nextPlacement));
    }

    const done = counted?.done ?? 0;
    const dropped = counted?.dropped ?? 0;
    const counts: PlanRootCounts = {
      steps: steps.length + done + dropped,
      needsYou: columns.needs_you,
      inFlight: columns.in_flight,
      upNext: columns.up_next,
      done,
      dropped,
    };
    const truncated: PlanNodeListTruncation | undefined =
      counted?.cut === true
        ? { bound: 'nodes', value: bounds.maxNodes }
        : counted?.deeper === true
          ? { bound: 'depth', value: bounds.maxDepth }
          : undefined;
    const state = planRootState(root.status, counts);
    return {
      nodeId: root.nodeId,
      title: root.title,
      status: root.status,
      position: root.position,
      revision: root.revision,
      // Steps the read did not reach may be open: never finished.
      state: truncated !== undefined && state === 'finished' ? 'queued' : state,
      counts,
      ...(truncated !== undefined ? { truncated } : {}),
      lastWrittenAt,
    };
  });

  // The lanes hold the steps of the plans listed: they are cut short wherever
  // a plan's row is, and wherever a plan was left unlisted.
  const cutRows = rows.flatMap((row) => (row.truncated !== undefined ? [row.truncated] : []));
  const lanesTruncated: PlanNodeListTruncation | undefined =
    roots.length < read.rootsTotal || cutRows.some((cut) => cut.bound === 'nodes')
      ? { bound: 'nodes', value: bounds.maxNodes }
      : cutRows[0];
  return {
    roots: rows,
    lanes: {
      needsYou: lane(needsYou, laneLimit),
      inFlight: lane(inFlight, laneLimit),
      upNext: lane(upNext, upNext.length),
      ...(lanesTruncated !== undefined ? { truncated: lanesTruncated } : {}),
    },
    ...(roots.length < read.rootsTotal
      ? { truncated: { bound: 'nodes' as const, value: bounds.maxNodes } }
      : {}),
  };
}

// ============================================================================
// The node detail's link cursor
// ============================================================================

/** A timestamp as Postgres prints one, or as an ISO string. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** Opaque to the client: where the page before ended. */
export function encodePlanLinkCursor(key: PlanLinkPageKey): string {
  return Buffer.from(JSON.stringify([key.at, key.kind, key.ref]), 'utf8').toString('base64url');
}

/** The key a cursor names, or null for one this server did not issue. */
export function decodePlanLinkCursor(cursor: string): PlanLinkPageKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [at, kind, ref] = parsed as unknown[];
    const linkKind = PlanNodeLinkKindSchema.safeParse(kind);
    if (typeof at !== 'string' || !CURSOR_TIME.test(at) || typeof ref !== 'string') return null;
    return linkKind.success ? { at, kind: linkKind.data, ref } : null;
  } catch {
    return null;
  }
}
